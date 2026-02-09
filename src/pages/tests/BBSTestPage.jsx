import { useState, useRef, useEffect, useCallback } from 'react';
import { PageContainer, Header } from '../../components/layout';
import { Button, Card, Alert, ProgressBar, Badge } from '../../components/ui';
import { PatientInfoForm, DualVideoUpload } from '../../components/forms';
import { drawConnections, drawLandmarks } from '../../utils/poseDrawing';
import { calculateBBSRisk, getRiskColorClasses } from '../../utils/riskCalculation';
import {
  analyzeSitToStand,
  calculateSitToStandScore,
  getVisualizationData,
  generateAssessmentReport,
  resetStateHistory,
  PostureState,
  HandPosition,
  HandSupportState
} from '../../utils/sitToStandAnalysis';
import {
  analyzeStandingUnsupported,
  calculateStandingScore,
  generateStandingReport,
  resetStandingAnalysis
} from '../../utils/standingUnsupportedAnalysis';
import {
  analyzeArmReach,
  recordInitialPosition,
  calculateArmReachScore,
  generateArmReachReport,
  resetArmReachAnalysis,
  isReturningFromReach,
  markArmReachComplete
} from '../../utils/armReachAnalysis';
import {
  analyzePickUp,
  recordPickUpInitial,
  calculatePickUpScore,
  generatePickUpReport,
  resetPickUpAnalysis,
  isPickUpSequenceComplete,
  markPickUpComplete,
  recordPhase
} from '../../utils/pickUpObjectAnalysis';
import {
  analyzeLookBehind,
  recordLookBehindInitial,
  calculateLookBehindScore,
  generateLookBehindReport,
  resetLookBehindAnalysis,
  isLookBehindComplete,
  markLookBehindComplete
} from '../../utils/lookBehindAnalysis';
import {
  analyzeTurn360,
  recordTurn360Initial,
  harvestCurrentTurnResult,
  prepareTurn360SecondTurn,
  isTurn360TurnComplete,
  markTurn360Complete,
  calculateTurn360Score,
  generateTurn360Report,
  resetTurn360Analysis
} from '../../utils/turn360Analysis';
import {
  analyzeStepAlternating,
  recordStepAlternatingInitial,
  markStepAlternatingComplete,
  calculateStepAlternatingScore,
  generateStepAlternatingReport,
  resetStepAlternatingAnalysis
} from '../../utils/stepAlternatingAnalysis';
import {
  analyzeTandemStance,
  recordTandemStanceInitial,
  markTandemStanceComplete,
  calculateTandemStanceScore,
  generateTandemStanceReport,
  resetTandemStanceAnalysis
} from '../../utils/tandemStanceAnalysis';
import {
  analyzeSingleLegStance,
  recordSingleLegStanceInitial,
  markSingleLegStanceComplete,
  calculateSingleLegStanceScore,
  generateSingleLegStanceReport,
  resetSingleLegStanceAnalysis
} from '../../utils/singleLegStanceAnalysis';
import { calibrate, resetCalibration } from '../../utils/bodyCalibration';
import { BBS_ITEMS } from '../../constants';
import { useNavigation, PAGES } from '../../context/NavigationContext';
import { useTestHistory } from '../../context/TestHistoryContext';

/**
 * 음성 안내 함수
 */
const speak = (text, rate = 1.0) => {
  if ('speechSynthesis' in window) {
    // 이전 음성 중단
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ko-KR';
    utterance.rate = rate;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    // 한국어 음성 찾기
    const voices = window.speechSynthesis.getVoices();
    const koreanVoice = voices.find(voice => voice.lang.includes('ko'));
    if (koreanVoice) {
      utterance.voice = koreanVoice;
    }

    window.speechSynthesis.speak(utterance);
  }
};

/**
 * 캔버스에 각도 정보 그리기
 */
function drawAngleInfo(ctx, analysis, landmarks, width, height) {
  if (!analysis || !landmarks) return;

  const vizData = getVisualizationData(analysis, landmarks);
  if (!vizData) return;

  ctx.save();

  // 무릎 각도 표시
  if (vizData.kneeAngle) {
    const kx = vizData.kneeAnglePosition.x * width;
    const ky = vizData.kneeAnglePosition.y * height;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.beginPath();
    ctx.roundRect(kx - 35, ky - 25, 70, 25, 5);
    ctx.fill();

    ctx.fillStyle = '#FCD34D';
    ctx.font = 'bold 12px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(`무릎 ${Math.round(vizData.kneeAngle)}°`, kx, ky - 8);
  }

  // 엉덩이 각도 표시
  if (vizData.hipAngle) {
    const hx = vizData.hipAnglePosition.x * width;
    const hy = vizData.hipAnglePosition.y * height;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.beginPath();
    ctx.roundRect(hx - 40, hy - 25, 80, 25, 5);
    ctx.fill();

    ctx.fillStyle = '#60A5FA';
    ctx.font = 'bold 12px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(`엉덩이 ${Math.round(vizData.hipAngle)}°`, hx, hy - 8);
  }

  // 상태 표시 박스 (화면 중앙 상단)
  const stateText = analysis.state === PostureState.SITTING ? '앉음 감지' :
                    analysis.state === PostureState.STANDING ? '서있음 감지' : '감지 중';

  ctx.fillStyle = vizData.stateColor;
  ctx.beginPath();
  ctx.roundRect(width / 2 - 60, 10, 120, 35, 8);
  ctx.fill();

  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 16px Arial';
  ctx.textAlign = 'center';
  ctx.fillText(stateText, width / 2, 33);

  ctx.restore();
}

function BBSTestPage() {
  const [currentItem, setCurrentItem] = useState(0);
  const [scores, setScores] = useState(Array(14).fill(null));
  const [isComplete, setIsComplete] = useState(false);
  const [patientInfo, setPatientInfo] = useState({ name: '홍길동', id: 'P-DEMO-001', height: '' });
  const [showSetup, setShowSetup] = useState(true);

  // 영상 업로드 상태 — 항목별 독립 관리
  const [itemVideos, setItemVideos] = useState(
    Array.from({ length: 14 }, () => ({ sideFile: null, sideUrl: null, frontFile: null, frontUrl: null }))
  );
  // 현재 항목의 분석용 영상 URL (측면 우선, 없으면 정면)
  const videoUrl = itemVideos[currentItem]?.sideUrl || itemVideos[currentItem]?.frontUrl || null;

  // 영상 분석 모드 표시 (업로드 영상 자동 분석 중)
  const [videoAnalyzing, setVideoAnalyzing] = useState(false);
  const [videoProgress, setVideoProgress] = useState(0); // 영상 재생 진행률 (0-100)

  // 입력 모드: 'upload' | 'camera'
  const [inputMode, setInputMode] = useState('upload');

  // 카메라/분석 상태
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [cameraLoading, setCameraLoading] = useState(false);
  const [itemTimer, setItemTimer] = useState(0);
  const [, setCurrentLandmarks] = useState(null);

  // 항목 1 전용 상태 - 단계별 검사 시스템
  // testPhase: 'waiting' -> 'sitting_confirmed' -> 'standing_up' -> 'complete'
  const [sitToStandState, setSitToStandState] = useState({
    testPhase: 'waiting', // waiting, sitting_confirmed, standing_up, complete
    currentPosture: PostureState.UNKNOWN,
    handPosition: HandPosition.UNKNOWN,
    handSupport: HandSupportState.UNKNOWN,
    sittingConfidence: 0,
    standingConfidence: 0,
    kneeAngle: 0,
    hipAngle: 0,
    feedback: { message: '의자에 앉아주세요...', type: 'info' },
    sittingConfirmedAt: null, // 앉음 확인 시간
    standingDetectedAt: null, // 서있음 감지 시간
    usedHandsDuringTransition: false,
    handUsageDetectedAt: null, // 손 사용 감지 시간
    autoScore: null,
    assessmentReport: null,
    showResultModal: false,
    debug: null
  });

  // 일반 항목용 상태
  const [generalDetection, setGeneralDetection] = useState({
    status: '대기',
    confidence: 0,
    suggestedScore: null,
    message: ''
  });

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const timerRef = useRef(null);
  const poseRef = useRef(null);
  const animationFrameRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const startItemRef = useRef(null); // 영상 업로드 시 자동 분석 시작용
  const prevVideoAnalyzingRef = useRef(false); // 영상 재생 종료 감지용
  const analysisHistoryRef = useRef([]);
  const previousAnalysisRef = useRef(null);
  const startTimeRef = useRef(null);
  const calibratedRef = useRef(false);
  const patientHeightRef = useRef('');

  const { navigateTo } = useNavigation();
  const { addTestResult } = useTestHistory();

  const currentBBSItem = BBS_ITEMS[currentItem];
  const isItem1 = currentItem === 0;
  const isItem2 = currentItem === 1;
  const isItem8 = currentItem === 7;
  const isItem9 = currentItem === 8;
  const isItem10 = currentItem === 9;
  const isItem11 = currentItem === 10;
  const isItem12 = currentItem === 11;
  const isItem13 = currentItem === 12;
  const isItem14 = currentItem === 13;

  // 항목 8 전용 상태 - 팔 뻗어 앞으로 내밀기
  const [armReachState, setArmReachState] = useState({
    testPhase: 'waiting', // waiting, reaching, complete
    isStanding: false,
    armRaised: false,
    shoulderAngle: 0,
    elbowAngle: 0,
    currentReachCm: 0,
    maxReachCm: 0,
    feetMoved: false,
    feetEverMoved: false,
    viewAngle: null,
    readyConfirmedAt: null,
    feedback: { message: '서서 팔을 앞으로 90도 뻗어주세요', type: 'info' },
    autoScore: null,
    assessmentReport: null,
    showResultModal: false
  });

  // 항목 9 전용 상태 - 바닥의 물건 집기
  const [pickUpState, setPickUpState] = useState({
    testPhase: 'waiting', // waiting, bending, complete
    isStanding: false,
    isBending: false,
    bendAngle: 0,
    wristToAnkleCm: 0,
    minWristToAnkleCm: 0,
    reachedFloor: false,
    feetMoved: false,
    feetEverMoved: false,
    readyConfirmedAt: null,
    feedback: { message: '바닥의 물건을 집기 위해 서 주세요', type: 'info' },
    autoScore: null,
    assessmentReport: null,
    showResultModal: false
  });

  // 항목 10 전용 상태 - 뒤돌아보기
  const [lookBehindState, setLookBehindState] = useState({
    testPhase: 'waiting', // waiting, measuring, complete
    isStanding: false,
    rotationAngle: 0,
    turnDirection: 'center',
    leftMaxRotation: 0,
    rightMaxRotation: 0,
    weightShift: 0,
    leftWeightShift: 0,
    rightWeightShift: 0,
    isAtCenter: true,
    feetMoved: false,
    feetEverMoved: false,
    viewAngle: null,
    readyConfirmedAt: null,
    feedback: { message: '정면을 보고 서 주세요', type: 'info' },
    autoScore: null,
    assessmentReport: null,
    showResultModal: false
  });

  // 항목 11 전용 상태 - 360도 회전
  // testFlow: 'waiting' -> 'measuring_first' -> 'pausing' -> 'measuring_second' -> 'complete'
  const [turn360State, setTurn360State] = useState({
    testFlow: 'waiting',
    phase: 'facing_front',     // 현재 위상
    widthRatio: 1.0,
    turnDirection: 'unknown',
    poseLost: false,
    poseLostDuration: 0,
    elapsedSec: 0,
    isStanding: false,
    feetMoved: false,
    feetEverMoved: false,
    visibility: 100,
    progress: 0,
    firstTurnResult: null,
    secondTurnResult: null,
    readyConfirmedAt: null,
    pauseStartedAt: null,
    feedback: { message: '정면을 보고 서 주세요', type: 'info' },
    autoScore: null,
    assessmentReport: null,
    showResultModal: false
  });

  // 항목 12 전용 상태 - 발판에 발 교대로 올리기
  const [stepAlternatingState, setStepAlternatingState] = useState({
    testPhase: 'waiting', // waiting, measuring, complete
    isStanding: false,
    stepCount: 0,
    alternatingCount: 0,
    lastStepFoot: null,
    isLeftUp: false,
    isRightUp: false,
    elapsedSec: 0,
    feetEverMoved: false,
    readyConfirmedAt: null,
    feedback: { message: '발판 앞에 서 주세요', type: 'info' },
    autoScore: null,
    assessmentReport: null,
    showResultModal: false
  });

  // 항목 13 전용 상태 - 일렬로 서기 (탄뎀 서기)
  const [tandemStanceState, setTandemStanceState] = useState({
    testPhase: 'waiting', // waiting, measuring, complete
    isStanding: false,
    stanceType: 'none',
    bestStanceType: 'none',
    stanceDuration: 0,
    maxDuration: 0,
    feetXGap: 0,
    feetYGap: 0,
    frontFoot: null,
    readyConfirmedAt: null,
    feedback: { message: '바르게 서 주세요', type: 'info' },
    autoScore: null,
    assessmentReport: null,
    showResultModal: false
  });

  // 항목 14 전용 상태 - 한 발로 서기
  const [singleLegState, setSingleLegState] = useState({
    testPhase: 'waiting', // waiting, measuring, complete
    isStanding: false,
    liftedFoot: null,
    liftDuration: 0,
    maxDuration: 0,
    bestLiftedFoot: null,
    readyConfirmedAt: null,
    feedback: { message: '바르게 서 주세요', type: 'info' },
    autoScore: null,
    assessmentReport: null,
    showResultModal: false
  });

  // 항목 2 전용 상태 - 잡지 않고 서 있기
  // testPhase: 'waiting' -> 'timing' -> 'complete'
  const [standingState, setStandingState] = useState({
    testPhase: 'waiting', // waiting, timing, complete
    currentState: 'not_standing',
    stabilityLevel: 'good',
    isStanding: false,
    isUsingSupport: false, // 지지물 사용 여부
    standingStartTime: null,
    standingDuration: 0,
    targetDuration: 120, // 2분
    supportSeekingCount: 0,
    unstableTime: 0,
    lostBalance: false,
    feedback: { message: '서 있는 자세를 취해주세요...', type: 'info' },
    autoScore: null,
    assessmentReport: null,
    showResultModal: false,
    debug: null
  });

  // 항목 1 전용 분석 - 단계별 검사
  const handleItem1Analysis = useCallback((landmarks) => {
    const analysis = analyzeSitToStand(landmarks, previousAnalysisRef.current);
    const now = Date.now();

    // 히스토리 저장
    analysisHistoryRef.current.push({
      ...analysis,
      timestamp: now
    });

    if (analysisHistoryRef.current.length > 150) {
      analysisHistoryRef.current.shift();
    }

    previousAnalysisRef.current = {
      ...analysis,
      handSupportUsed: sitToStandState.usedHandsDuringTransition ||
        analysis.handPosition?.support !== HandSupportState.NO_SUPPORT
    };

    setSitToStandState(prev => {
      let newPhase = prev.testPhase;
      let newFeedback = prev.feedback;
      let sittingConfirmedAt = prev.sittingConfirmedAt;
      let standingDetectedAt = prev.standingDetectedAt;
      let usedHands = prev.usedHandsDuringTransition;
      let handUsageDetectedAt = prev.handUsageDetectedAt;
      let autoScore = prev.autoScore;
      let assessmentReport = prev.assessmentReport;
      let showResultModal = prev.showResultModal;

      // 단계 1: 앉음 대기 중
      if (prev.testPhase === 'waiting') {
        if (analysis.state === PostureState.SITTING && analysis.sitting?.confidence > 50) {
          // 앉음 감지됨 - 1초간 유지되면 확정
          if (!sittingConfirmedAt) {
            sittingConfirmedAt = now;
            newFeedback = { message: '앉은 자세 감지 중... 잠시 유지해주세요', type: 'info' };
          } else if (now - sittingConfirmedAt > 1500) {
            // 1.5초간 앉음 유지 = 확정
            newPhase = 'sitting_confirmed';
            newFeedback = { message: '✓ 앉은 자세 확인! 이제 일어서세요', type: 'success' };
          }
        } else {
          sittingConfirmedAt = null;
          newFeedback = { message: '의자에 앉아주세요...', type: 'info' };
        }
      }

      // 단계 2: 앉음 확정 - 일어서기 대기
      if (prev.testPhase === 'sitting_confirmed') {
        // 손 사용 감지 (무릎 짚기)
        if (analysis.handPosition?.support === HandSupportState.HEAVY_SUPPORT ||
            analysis.handPosition?.position === HandPosition.HANDS_PUSHING) {
          if (!usedHands) {
            usedHands = true;
            handUsageDetectedAt = now;
          }
          newFeedback = { message: '⚠️ 손 사용 감지! (감점)', type: 'error' };
        }

        // 일어서기 시작 감지
        if (analysis.standing?.confidence > 30 || analysis.isTransitioning) {
          newPhase = 'standing_up';
          newFeedback = { message: '일어서는 중...', type: 'info' };
        }
      }

      // 단계 3: 일어서는 중
      if (prev.testPhase === 'standing_up') {
        // 손 사용 감지
        if (analysis.handPosition?.support === HandSupportState.HEAVY_SUPPORT ||
            analysis.handPosition?.position === HandPosition.HANDS_PUSHING) {
          if (!usedHands) {
            usedHands = true;
            handUsageDetectedAt = now;
          }
          newFeedback = { message: '⚠️ 손 사용 감지! (감점)', type: 'error' };
        }

        // 서있음 확정 감지
        if (analysis.state === PostureState.STANDING && analysis.standing?.confidence > 55) {
          if (!standingDetectedAt) {
            standingDetectedAt = now;
          } else if (now - standingDetectedAt > 1000) {
            // 1초간 서있음 유지 = 검사 완료!
            newPhase = 'complete';
            autoScore = calculateSitToStandScore(analysisHistoryRef.current);
            assessmentReport = generateAssessmentReport(analysisHistoryRef.current, autoScore);
            showResultModal = true;
            newFeedback = {
              message: usedHands ? '검사 완료 (손 사용으로 감점)' : '✓ 검사 완료! 훌륭합니다!',
              type: usedHands ? 'warning' : 'success'
            };
          } else {
            newFeedback = { message: '서있는 자세 확인 중...', type: 'info' };
          }
        } else {
          standingDetectedAt = null;
        }
      }

      return {
        ...prev,
        testPhase: newPhase,
        currentPosture: analysis.state,
        handPosition: analysis.handPosition?.position || HandPosition.UNKNOWN,
        handSupport: analysis.handPosition?.support || HandSupportState.UNKNOWN,
        sittingConfidence: analysis.sitting?.confidence || 0,
        standingConfidence: analysis.standing?.confidence || 0,
        kneeAngle: analysis.sitting?.details?.kneeAngle || analysis.standing?.details?.kneeAngle || 0,
        hipAngle: analysis.sitting?.details?.hipAngle || analysis.standing?.details?.hipAngle || 0,
        feedback: newFeedback,
        sittingConfirmedAt,
        standingDetectedAt,
        usedHandsDuringTransition: usedHands,
        handUsageDetectedAt,
        autoScore,
        assessmentReport,
        showResultModal,
        debug: analysis.debug
      };
    });

    return analysis;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sitToStandState.testPhase, sitToStandState.usedHandsDuringTransition]);

  // 항목 2 전용 분석 - 잡지 않고 서 있기
  const handleItem2Analysis = useCallback((landmarks) => {
    if (!landmarks || landmarks.length < 33) {
      return { stability: 'good', isStanding: false, state: 'not_standing' };
    }

    const analysis = analyzeStandingUnsupported(landmarks);
    if (!analysis) {
      return { stability: 'good', isStanding: false, state: 'not_standing' };
    }

    const now = Date.now();

    setStandingState(prev => {
      let newPhase = prev.testPhase;
      let newFeedback = prev.feedback;
      let standingStartTime = prev.standingStartTime;
      let standingDuration = prev.standingDuration;
      let supportSeekingCount = prev.supportSeekingCount;
      let unstableTime = prev.unstableTime;
      let lostBalance = prev.lostBalance;
      let autoScore = prev.autoScore;
      let assessmentReport = prev.assessmentReport;
      let showResultModal = prev.showResultModal;

      // 단계 1: 서있기 대기 중
      if (prev.testPhase === 'waiting') {
        // 지지물 사용 중이면 타이머 시작하지 않음
        if (analysis.isUsingSupport) {
          newFeedback = {
            message: analysis.supportUsageMessage || '⚠️ 지지물을 놓아주세요',
            type: 'warning'
          };
        }
        // 지지 없이 서 있을 때만 타이머 시작
        else if (analysis.isStandingUnsupported && analysis.confidence > 0.6) {
          // 지지 없이 서있음 감지 - 타이머 시작
          if (!standingStartTime) {
            standingStartTime = now;
            newPhase = 'timing';
            newFeedback = { message: '✓ 지지 없이 서있음 확인! 유지해주세요', type: 'success' };
          }
        } else if (analysis.isStanding && !analysis.isStandingUnsupported) {
          // 서 있지만 지지물 사용 중
          newFeedback = { message: '⚠️ 지지물을 놓고 서 주세요', type: 'warning' };
        } else {
          newFeedback = { message: '서 있는 자세를 취해주세요...', type: 'info' };
        }
      }

      // 단계 2: 시간 측정 중
      if (prev.testPhase === 'timing') {
        if (standingStartTime) {
          standingDuration = (now - standingStartTime) / 1000;
        }

        // 지지물 사용 감지 (벽, 지팡이 등)
        if (analysis.isUsingSupport) {
          supportSeekingCount = prev.supportSeekingCount + 1;
          newFeedback = {
            message: analysis.supportUsageMessage || '⚠️ 지지물 사용 감지 (감독 필요)',
            type: 'warning'
          };
        }
        // 지지 요청 행동 감지
        else if (analysis.supportSeeking) {
          supportSeekingCount = prev.supportSeekingCount + 1;
          newFeedback = { message: analysis.supportMessage || '⚠️ 균형 유지 중', type: 'warning' };
        }

        // 불안정 시간 누적
        if (analysis.stability === 'poor' || analysis.stability === 'critical') {
          unstableTime = prev.unstableTime + 0.1; // 약 100ms마다 호출되므로
        }

        // 균형 상실 감지
        if (analysis.balanceLost) {
          lostBalance = true;
          // 균형 상실 시 즉시 완료
          newPhase = 'complete';
          autoScore = calculateStandingScore(standingDuration, supportSeekingCount > 5, true, unstableTime, 1);
          assessmentReport = generateStandingReport(autoScore.score, standingDuration, {
            avgStability: analysis.stability,
            supportEvents: supportSeekingCount
          });
          showResultModal = true;
          newFeedback = { message: '⚠️ 균형 상실 감지', type: 'error' };
        }
        // 목표 시간 달성 확인
        else if (standingDuration >= prev.targetDuration) {
          newPhase = 'complete';
          autoScore = calculateStandingScore(standingDuration, supportSeekingCount > 5, false, unstableTime, 1);
          assessmentReport = generateStandingReport(autoScore.score, standingDuration, {
            avgStability: analysis.stability,
            supportEvents: supportSeekingCount
          });
          showResultModal = true;
          newFeedback = { message: '✓ 2분 완료! 훌륭합니다!', type: 'success' };
        }
        // 30초 이상 버틴 경우 - 수동 완료 버튼 표시
        else if (standingDuration >= 30 && !analysis.isStanding) {
          // 서있지 않게 된 경우 (앉거나 넘어짐)
          newPhase = 'complete';
          autoScore = calculateStandingScore(standingDuration, supportSeekingCount > 5, false, unstableTime, 1);
          assessmentReport = generateStandingReport(autoScore.score, standingDuration, {
            avgStability: analysis.stability,
            supportEvents: supportSeekingCount
          });
          showResultModal = true;
          newFeedback = { message: `${standingDuration.toFixed(1)}초간 서 있음`, type: 'info' };
        }
        // 진행 중 피드백
        else {
          const remaining = Math.ceil(prev.targetDuration - standingDuration);
          if (analysis.stability === 'excellent' || analysis.stability === 'good') {
            newFeedback = { message: `안정적! 남은 시간: ${remaining}초`, type: 'success' };
          } else if (analysis.stability === 'moderate') {
            newFeedback = { message: `약간 흔들림 - 남은 시간: ${remaining}초`, type: 'warning' };
          } else {
            newFeedback = { message: `⚠️ 불안정 - 균형 유지하세요!`, type: 'error' };
          }
        }
      }

      return {
        ...prev,
        testPhase: newPhase,
        currentState: analysis.state,
        stabilityLevel: analysis.stability,
        isStanding: analysis.isStanding,
        isUsingSupport: analysis.isUsingSupport, // 지지물 사용 여부
        standingStartTime,
        standingDuration,
        supportSeekingCount,
        unstableTime,
        lostBalance,
        feedback: newFeedback,
        autoScore,
        assessmentReport,
        showResultModal,
        debug: analysis.debug
      };
    });

    return analysis;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [standingState.testPhase]);

  // 항목 8 전용 분석 - 팔 뻗어 앞으로 내밀기
  const handleItem8Analysis = useCallback((landmarks) => {
    const analysis = analyzeArmReach(landmarks);
    if (!analysis) return null;

    const now = Date.now();

    setArmReachState(prev => {
      let newPhase = prev.testPhase;
      let newFeedback = prev.feedback;
      let readyConfirmedAt = prev.readyConfirmedAt;
      let autoScore = prev.autoScore;
      let assessmentReport = prev.assessmentReport;
      let showResultModal = prev.showResultModal;

      // 단계 1: 서서 팔 90도 들기 대기
      if (prev.testPhase === 'waiting') {
        if (analysis.isStanding && analysis.armRaised) {
          if (!readyConfirmedAt) {
            readyConfirmedAt = now;
            newFeedback = { message: '팔 감지됨... 자세를 유지하세요', type: 'info' };
          } else if (now - readyConfirmedAt > 1500) {
            // 1.5초 유지 → 초기 위치 기록 후 측정 시작
            // 실제 영상 aspect ratio 전달
            const video = videoRef.current;
            const ar = (video && video.videoWidth && video.videoHeight)
              ? video.videoWidth / video.videoHeight
              : 16 / 9;
            recordInitialPosition(landmarks, ar);
            newPhase = 'reaching';
            newFeedback = { message: '측정 시작! 최대한 앞으로 뻗으세요', type: 'success' };
          }
        } else {
          readyConfirmedAt = null;
          if (!analysis.isStanding) {
            newFeedback = { message: '서 있는 자세를 취해주세요', type: 'info' };
          } else {
            newFeedback = { message: '팔을 앞으로 90도 뻗어주세요', type: 'info' };
          }
        }
      }

      // 단계 2: 뻗기 측정 중
      if (prev.testPhase === 'reaching') {
        if (analysis.feetEverMoved) {
          newFeedback = { message: `발 움직임 감지! 현재 ${analysis.maxReachCm}cm`, type: 'warning' };
        } else if (analysis.maxReachCm >= 25) {
          newFeedback = { message: `${analysis.currentReachCm}cm (최대: ${analysis.maxReachCm}cm)`, type: 'success' };
        } else {
          newFeedback = { message: `${analysis.currentReachCm}cm (최대: ${analysis.maxReachCm}cm)`, type: 'info' };
        }

        // 자동 완료: 충분히 뻗은 후 돌아오면
        if (isReturningFromReach()) {
          markArmReachComplete();
          newPhase = 'complete';
          autoScore = calculateArmReachScore(analysis.maxReachCm, analysis.feetEverMoved, false);
          assessmentReport = generateArmReachReport(autoScore, analysis.maxReachCm, analysis.feetEverMoved);
          showResultModal = true;
          newFeedback = { message: `측정 완료! 최대 ${analysis.maxReachCm}cm`, type: 'success' };
        }
      }

      return {
        ...prev,
        testPhase: newPhase,
        isStanding: analysis.isStanding,
        armRaised: analysis.armRaised,
        shoulderAngle: analysis.shoulderAngle,
        elbowAngle: analysis.elbowAngle,
        currentReachCm: analysis.currentReachCm,
        maxReachCm: analysis.maxReachCm,
        feetMoved: analysis.feetMoved,
        feetEverMoved: analysis.feetEverMoved,
        viewAngle: analysis.viewAngle,
        readyConfirmedAt,
        feedback: newFeedback,
        autoScore,
        assessmentReport,
        showResultModal
      };
    });

    return analysis;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armReachState.testPhase]);

  // 항목 9 전용 분석 - 바닥의 물건 집기
  const handleItem9Analysis = useCallback((landmarks) => {
    const analysis = analyzePickUp(landmarks);
    if (!analysis) return null;

    const now = Date.now();

    setPickUpState(prev => {
      let newPhase = prev.testPhase;
      let newFeedback = prev.feedback;
      let readyConfirmedAt = prev.readyConfirmedAt;
      let autoScore = prev.autoScore;
      let assessmentReport = prev.assessmentReport;
      let showResultModal = prev.showResultModal;

      // 단계 1: 서있기 대기 (1.5초 유지)
      if (prev.testPhase === 'waiting') {
        if (analysis.isStanding && !analysis.isBending) {
          if (!readyConfirmedAt) {
            readyConfirmedAt = now;
            newFeedback = { message: '서 있는 자세 감지... 유지하세요', type: 'info' };
          } else if (now - readyConfirmedAt > 1500) {
            const video = videoRef.current;
            const ar = (video && video.videoWidth && video.videoHeight)
              ? video.videoWidth / video.videoHeight
              : 16 / 9;
            recordPickUpInitial(landmarks, ar);
            recordPhase('standing'); // 초기 서있기 기록
            newPhase = 'bending';
            newFeedback = { message: '측정 시작! 허리를 굽혀 바닥의 물건을 집으세요', type: 'success' };
          }
        } else {
          readyConfirmedAt = null;
          newFeedback = { message: '서 있는 자세를 취해주세요', type: 'info' };
        }
      }

      // 단계 2: 허리 굽히기 측정 중
      if (prev.testPhase === 'bending') {
        // phase 기록
        if (analysis.isBending) {
          recordPhase('bending');
        } else if (analysis.isStanding && analysis.returnedToStand) {
          recordPhase('standing');
        }

        if (analysis.reachedFloor) {
          newFeedback = { message: `바닥 도달! 다시 일어서세요`, type: 'success' };
        } else if (analysis.isBending) {
          newFeedback = { message: `손목-발목 거리: ${analysis.wristToAnkleCm}cm`, type: 'info' };
        } else {
          newFeedback = { message: '허리를 굽혀 바닥의 물건을 집으세요', type: 'info' };
        }

        if (analysis.feetEverMoved) {
          newFeedback = { message: `발 움직임 감지! 거리: ${analysis.wristToAnkleCm}cm`, type: 'warning' };
        }

        // 자동 완료: standing→bending→standing 패턴 완성
        if (isPickUpSequenceComplete()) {
          markPickUpComplete();
          newPhase = 'complete';
          const minDist = analysis.minWristToAnkleCm;
          const reached = minDist <= 0; // 음수이면 바닥 아래 도달
          autoScore = calculatePickUpScore(Math.max(0, minDist), reached, analysis.feetEverMoved, false);
          assessmentReport = generatePickUpReport(autoScore, Math.max(0, minDist), reached, analysis.feetEverMoved);
          showResultModal = true;
          newFeedback = { message: `측정 완료! ${reached ? '바닥 도달 성공' : `바닥까지 ${minDist}cm`}`, type: 'success' };
        }
      }

      return {
        ...prev,
        testPhase: newPhase,
        isStanding: analysis.isStanding,
        isBending: analysis.isBending,
        bendAngle: analysis.bendAngle,
        wristToAnkleCm: analysis.wristToAnkleCm,
        minWristToAnkleCm: Math.min(prev.minWristToAnkleCm, analysis.wristToAnkleCm),
        reachedFloor: prev.reachedFloor || analysis.reachedFloor,
        feetMoved: analysis.feetMoved,
        feetEverMoved: prev.feetEverMoved || analysis.feetEverMoved,
        readyConfirmedAt,
        feedback: newFeedback,
        autoScore,
        assessmentReport,
        showResultModal
      };
    });

    return analysis;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickUpState.testPhase]);

  // 항목 10 전용 분석 - 뒤돌아보기
  const handleItem10Analysis = useCallback((landmarks) => {
    const analysis = analyzeLookBehind(landmarks);
    if (!analysis) return null;

    const now = Date.now();

    setLookBehindState(prev => {
      let newPhase = prev.testPhase;
      let newFeedback = prev.feedback;
      let readyConfirmedAt = prev.readyConfirmedAt;
      let autoScore = prev.autoScore;
      let assessmentReport = prev.assessmentReport;
      let showResultModal = prev.showResultModal;

      // 단계 1: 서있기 대기 (1.5초 유지)
      if (prev.testPhase === 'waiting') {
        if (analysis.isStanding) {
          if (!readyConfirmedAt) {
            readyConfirmedAt = now;
            newFeedback = { message: '서 있는 자세 감지... 유지하세요', type: 'info' };
          } else if (now - readyConfirmedAt > 1500) {
            recordLookBehindInitial(landmarks);
            newPhase = 'measuring';
            newFeedback = { message: '왼쪽 어깨 너머로 뒤를 돌아보세요', type: 'success' };
          }
        } else {
          readyConfirmedAt = null;
          newFeedback = { message: '정면을 보고 서 주세요', type: 'info' };
        }
      }

      // 단계 2: 양방향 회전 측정
      if (prev.testPhase === 'measuring') {
        const leftDone = analysis.leftMaxRotation >= 20;
        const rightDone = analysis.rightMaxRotation >= 20;

        if (analysis.turnDirection === 'left' && analysis.rotationAngle > 10) {
          newFeedback = { message: `왼쪽 회전 중: ${analysis.rotationAngle}°`, type: 'info' };
        } else if (analysis.turnDirection === 'right' && analysis.rotationAngle > 10) {
          newFeedback = { message: `오른쪽 회전 중: ${analysis.rotationAngle}°`, type: 'info' };
        } else if (leftDone && !rightDone) {
          newFeedback = { message: `왼쪽 완료 (${analysis.leftMaxRotation}°)! 오른쪽으로 돌아보세요`, type: 'info' };
        } else if (!leftDone && rightDone) {
          newFeedback = { message: `오른쪽 완료 (${analysis.rightMaxRotation}°)! 왼쪽으로 돌아보세요`, type: 'info' };
        } else if (leftDone && rightDone && !analysis.isAtCenter) {
          newFeedback = { message: '양쪽 완료! 정면으로 돌아오세요', type: 'success' };
        } else if (!leftDone && !rightDone) {
          newFeedback = { message: '어깨 너머로 뒤를 돌아보세요', type: 'info' };
        }

        if (analysis.feetEverMoved) {
          newFeedback = { message: '발 움직임 감지! 발을 제자리에 두세요', type: 'warning' };
        }

        // 자동 완료: 양방향 충분 회전 + 중앙 복귀
        if (isLookBehindComplete()) {
          markLookBehindComplete();
          newPhase = 'complete';
          autoScore = calculateLookBehindScore(
            analysis.leftMaxRotation, analysis.rightMaxRotation,
            analysis.leftWeightShift, analysis.rightWeightShift,
            analysis.feetEverMoved, false
          );
          assessmentReport = generateLookBehindReport(
            autoScore,
            analysis.leftMaxRotation, analysis.rightMaxRotation,
            analysis.leftWeightShift, analysis.rightWeightShift,
            analysis.feetEverMoved
          );
          showResultModal = true;
          newFeedback = { message: `측정 완료! 좌 ${analysis.leftMaxRotation}° / 우 ${analysis.rightMaxRotation}°`, type: 'success' };
        }
      }

      return {
        ...prev,
        testPhase: newPhase,
        isStanding: analysis.isStanding,
        rotationAngle: analysis.rotationAngle,
        turnDirection: analysis.turnDirection,
        leftMaxRotation: analysis.leftMaxRotation,
        rightMaxRotation: analysis.rightMaxRotation,
        weightShift: analysis.weightShift,
        leftWeightShift: analysis.leftWeightShift,
        rightWeightShift: analysis.rightWeightShift,
        isAtCenter: analysis.isAtCenter,
        feetMoved: analysis.feetMoved,
        feetEverMoved: analysis.feetEverMoved,
        viewAngle: analysis.viewAngle,
        readyConfirmedAt,
        feedback: newFeedback,
        autoScore,
        assessmentReport,
        showResultModal
      };
    });

    return analysis;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookBehindState.testPhase]);

  // 항목 11 전용 분석 - 360도 회전
  const handleItem11Analysis = useCallback((landmarks, poseAvailable) => {
    const now = Date.now();

    setTurn360State(prev => {
      let newFlow = prev.testFlow;
      let newFeedback = prev.feedback;
      let readyConfirmedAt = prev.readyConfirmedAt;
      let pauseStartedAt = prev.pauseStartedAt;
      let firstTurnResult = prev.firstTurnResult;
      let secondTurnResult = prev.secondTurnResult;
      let autoScore = prev.autoScore;
      let assessmentReport = prev.assessmentReport;
      let showResultModal = prev.showResultModal;

      // waiting: 서있기 대기 (1.5초)
      if (prev.testFlow === 'waiting') {
        if (!poseAvailable || !landmarks) return prev;

        const lShoulder = landmarks[11], rShoulder = landmarks[12];
        const lHip = landmarks[23], rHip = landmarks[24];
        const lAnkle = landmarks[27], rAnkle = landmarks[28];
        const shoulderY = (lShoulder.y + rShoulder.y) / 2;
        const hipY = (lHip.y + rHip.y) / 2;
        const ankleY = (lAnkle.y + rAnkle.y) / 2;
        const denom = ankleY - shoulderY;
        const hipToAnkleRatio = denom > 0.001 ? (ankleY - hipY) / denom : 0;
        const isStanding = hipToAnkleRatio > 0.45;

        if (isStanding) {
          if (!readyConfirmedAt) {
            readyConfirmedAt = now;
            recordTurn360Initial(landmarks); // 즉시 초기 상태 기록
            newFeedback = { message: '서 있는 자세 감지! 준비 중...', type: 'info' };
          } else if (now - readyConfirmedAt > 300) {
            // 0.3초 후 측정 시작
            newFlow = 'measuring_first';
            newFeedback = { message: '1차 회전: 한쪽 방향으로 360도 돌아주세요', type: 'success' };
          }
        } else {
          readyConfirmedAt = null;
          newFeedback = { message: '정면을 보고 서 주세요', type: 'info' };
        }

        return { ...prev, testFlow: newFlow, readyConfirmedAt, feedback: newFeedback };
      }

      // measuring_first: 1차 회전 측정
      if (prev.testFlow === 'measuring_first') {
        const analysis = analyzeTurn360(landmarks, poseAvailable);
        if (!analysis) return prev;

        if (analysis.poseLost) {
          newFeedback = { message: '뒷면 감지 중... 계속 돌아주세요', type: 'info' };
        } else if (analysis.phase === 'turning_away') {
          newFeedback = { message: `회전 중 (${analysis.turnDirection === 'left' ? '왼쪽' : analysis.turnDirection === 'right' ? '오른쪽' : ''}): ${analysis.elapsedSec}초`, type: 'info' };
        } else if (analysis.phase === 'returning') {
          newFeedback = { message: '정면으로 돌아오는 중...', type: 'info' };
        }

        if (analysis.feetEverMoved) {
          newFeedback = { message: '발 움직임 감지! 제자리에서 돌아주세요', type: 'warning' };
        }

        // 1차 완료
        if (isTurn360TurnComplete()) {
          firstTurnResult = harvestCurrentTurnResult();
          pauseStartedAt = now;
          newFlow = 'pausing';
          newFeedback = { message: `1차 완료 (${firstTurnResult.direction === 'left' ? '왼쪽' : '오른쪽'} ${firstTurnResult.elapsedSec}초)! 3초 후 반대 방향으로...`, type: 'success' };
        }

        return {
          ...prev,
          testFlow: newFlow,
          phase: analysis.phase,
          widthRatio: analysis.widthRatio,
          turnDirection: analysis.turnDirection,
          poseLost: analysis.poseLost,
          poseLostDuration: analysis.poseLostDuration,
          elapsedSec: analysis.elapsedSec,
          isStanding: analysis.isStanding,
          feetMoved: analysis.feetMoved,
          feetEverMoved: analysis.feetEverMoved,
          visibility: analysis.visibility || 0,
          progress: analysis.progress,
          firstTurnResult,
          pauseStartedAt,
          feedback: newFeedback
        };
      }

      // pausing: 3초 대기
      if (prev.testFlow === 'pausing') {
        if (pauseStartedAt && now - pauseStartedAt >= 3000) {
          // 2차 회전 준비
          if (poseAvailable && landmarks) {
            prepareTurn360SecondTurn(landmarks);
          }
          newFlow = 'measuring_second';
          newFeedback = { message: '2차 회전: 반대 방향으로 360도 돌아주세요', type: 'success' };
        } else {
          const remaining = pauseStartedAt ? Math.ceil((3000 - (now - pauseStartedAt)) / 1000) : 3;
          newFeedback = { message: `${remaining}초 후 반대 방향으로 회전...`, type: 'info' };
        }
        return { ...prev, testFlow: newFlow, pauseStartedAt, feedback: newFeedback };
      }

      // measuring_second: 2차 회전 측정
      if (prev.testFlow === 'measuring_second') {
        const analysis = analyzeTurn360(landmarks, poseAvailable);
        if (!analysis) return prev;

        if (analysis.poseLost) {
          newFeedback = { message: '뒷면 감지 중... 계속 돌아주세요', type: 'info' };
        } else if (analysis.phase === 'turning_away') {
          newFeedback = { message: `회전 중 (${analysis.turnDirection === 'left' ? '왼쪽' : analysis.turnDirection === 'right' ? '오른쪽' : ''}): ${analysis.elapsedSec}초`, type: 'info' };
        } else if (analysis.phase === 'returning') {
          newFeedback = { message: '정면으로 돌아오는 중...', type: 'info' };
        }

        if (analysis.feetEverMoved) {
          newFeedback = { message: '발 움직임 감지! 제자리에서 돌아주세요', type: 'warning' };
        }

        // 2차 완료
        if (isTurn360TurnComplete()) {
          markTurn360Complete();
          secondTurnResult = harvestCurrentTurnResult();
          newFlow = 'complete';
          const totalFeetMoved = firstTurnResult?.feetMoved || secondTurnResult.feetMoved;
          autoScore = calculateTurn360Score(firstTurnResult, secondTurnResult, totalFeetMoved);
          assessmentReport = generateTurn360Report(autoScore, firstTurnResult, secondTurnResult, totalFeetMoved);
          showResultModal = true;
          newFeedback = { message: `측정 완료!`, type: 'success' };
        }

        return {
          ...prev,
          testFlow: newFlow,
          phase: analysis.phase,
          widthRatio: analysis.widthRatio,
          turnDirection: analysis.turnDirection,
          poseLost: analysis.poseLost,
          poseLostDuration: analysis.poseLostDuration,
          elapsedSec: analysis.elapsedSec,
          isStanding: analysis.isStanding,
          feetMoved: analysis.feetMoved,
          feetEverMoved: analysis.feetEverMoved,
          visibility: analysis.visibility || 0,
          progress: analysis.progress,
          secondTurnResult,
          autoScore,
          assessmentReport,
          showResultModal,
          feedback: newFeedback
        };
      }

      return prev;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turn360State.testFlow]);

  // 항목 12 전용 분석 - 발판에 발 교대로 올리기
  const handleItem12Analysis = useCallback((landmarks) => {
    const now = Date.now();

    setStepAlternatingState(prev => {
      let newPhase = prev.testPhase;
      let newFeedback = prev.feedback;
      let readyConfirmedAt = prev.readyConfirmedAt;
      let autoScore = prev.autoScore;
      let assessmentReport = prev.assessmentReport;
      let showResultModal = prev.showResultModal;

      // waiting: 서있기 대기 (0.3초)
      if (prev.testPhase === 'waiting') {
        if (!landmarks || landmarks.length < 33) return prev;

        const lShoulder = landmarks[11], rShoulder = landmarks[12];
        const lHip = landmarks[23], rHip = landmarks[24];
        const lAnkle = landmarks[27], rAnkle = landmarks[28];
        const shoulderY = (lShoulder.y + rShoulder.y) / 2;
        const hipY = (lHip.y + rHip.y) / 2;
        const ankleY = (lAnkle.y + rAnkle.y) / 2;
        const denom = ankleY - shoulderY;
        const hipToAnkleRatio = denom > 0.001 ? (ankleY - hipY) / denom : 0;
        const isStanding = hipToAnkleRatio > 0.45;

        if (isStanding) {
          if (!readyConfirmedAt) {
            readyConfirmedAt = now;
            recordStepAlternatingInitial(landmarks);
            newFeedback = { message: '서 있는 자세 감지! 준비 중...', type: 'info' };
          } else if (now - readyConfirmedAt > 300) {
            newPhase = 'measuring';
            newFeedback = { message: '시작! 발을 번갈아 올려주세요', type: 'success' };
          }
        } else {
          readyConfirmedAt = null;
          newFeedback = { message: '발판 앞에 바르게 서 주세요', type: 'info' };
        }

        return { ...prev, testPhase: newPhase, readyConfirmedAt, feedback: newFeedback };
      }

      // measuring: 매 프레임 분석
      if (prev.testPhase === 'measuring') {
        const analysis = analyzeStepAlternating(landmarks);
        if (!analysis) return prev;

        // 피드백 업데이트
        if (analysis.isLeftUp && !analysis.isRightUp) {
          newFeedback = { message: `왼발 올림! (${analysis.stepCount}회)`, type: 'info' };
        } else if (analysis.isRightUp && !analysis.isLeftUp) {
          newFeedback = { message: `오른발 올림! (${analysis.stepCount}회)`, type: 'info' };
        } else if (!analysis.isLeftUp && !analysis.isRightUp && analysis.stepCount > 0) {
          newFeedback = { message: `${analysis.stepCount}회 완료 — 계속 올려주세요`, type: 'success' };
        } else if (analysis.stepCount === 0) {
          newFeedback = { message: '발을 발판 위로 올려주세요', type: 'info' };
        }

        // 자동 완료: 8회 이상 달성
        if (analysis.stepCount >= 8) {
          newPhase = 'complete';
          markStepAlternatingComplete();
          autoScore = calculateStepAlternatingScore(
            analysis.stepCount, analysis.alternatingCount, analysis.elapsedSec, false
          );
          assessmentReport = generateStepAlternatingReport(
            autoScore, analysis.stepCount, analysis.alternatingCount, analysis.elapsedSec
          );
          showResultModal = true;
          newFeedback = { message: `측정 완료! ${analysis.stepCount}회`, type: 'success' };
        }

        // 자동 완료: 20초 초과
        if (newPhase !== 'complete' && analysis.elapsedSec > 20) {
          newPhase = 'complete';
          markStepAlternatingComplete();
          autoScore = calculateStepAlternatingScore(
            analysis.stepCount, analysis.alternatingCount, analysis.elapsedSec, false
          );
          assessmentReport = generateStepAlternatingReport(
            autoScore, analysis.stepCount, analysis.alternatingCount, analysis.elapsedSec
          );
          showResultModal = true;
          newFeedback = { message: `시간 초과. ${analysis.stepCount}회`, type: 'warning' };
        }

        return {
          ...prev,
          testPhase: newPhase,
          isStanding: analysis.isStanding,
          stepCount: analysis.stepCount,
          alternatingCount: analysis.alternatingCount,
          lastStepFoot: analysis.lastStepFoot,
          isLeftUp: analysis.isLeftUp,
          isRightUp: analysis.isRightUp,
          elapsedSec: analysis.elapsedSec,
          feetEverMoved: analysis.feetEverMoved,
          autoScore,
          assessmentReport,
          showResultModal,
          feedback: newFeedback
        };
      }

      return prev;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepAlternatingState.testPhase]);

  // 항목 13 전용 분석 - 일렬로 서기 (탄뎀 서기)
  const handleItem13Analysis = useCallback((landmarks) => {
    const now = Date.now();

    setTandemStanceState(prev => {
      let newPhase = prev.testPhase;
      let newFeedback = prev.feedback;
      let readyConfirmedAt = prev.readyConfirmedAt;
      let autoScore = prev.autoScore;
      let assessmentReport = prev.assessmentReport;
      let showResultModal = prev.showResultModal;

      // waiting: 서있기 감지 후 0.3초 → measuring
      if (prev.testPhase === 'waiting') {
        if (!landmarks || landmarks.length < 33) return prev;

        const lShoulder = landmarks[11], rShoulder = landmarks[12];
        const lHip = landmarks[23], rHip = landmarks[24];
        const lAnkle = landmarks[27], rAnkle = landmarks[28];
        const shoulderY = (lShoulder.y + rShoulder.y) / 2;
        const hipY = (lHip.y + rHip.y) / 2;
        const ankleY = (lAnkle.y + rAnkle.y) / 2;
        const denom = ankleY - shoulderY;
        const hipToAnkleRatio = denom > 0.001 ? (ankleY - hipY) / denom : 0;
        const isStanding = hipToAnkleRatio > 0.45;

        if (isStanding) {
          if (!readyConfirmedAt) {
            readyConfirmedAt = now;
            recordTandemStanceInitial(landmarks);
            newFeedback = { message: '서 있는 자세 감지! 준비 중...', type: 'info' };
          } else if (now - readyConfirmedAt > 300) {
            newPhase = 'measuring';
            newFeedback = { message: '한 발을 다른 발 앞에 일렬로 놓으세요', type: 'success' };
          }
        } else {
          readyConfirmedAt = null;
          newFeedback = { message: '바르게 서 주세요', type: 'info' };
        }

        return { ...prev, testPhase: newPhase, readyConfirmedAt, feedback: newFeedback };
      }

      // measuring: 매 프레임 분석
      if (prev.testPhase === 'measuring') {
        const analysis = analyzeTandemStance(landmarks);
        if (!analysis) return prev;

        const stanceLabels = { tandem: '탄뎀 자세', forward: '앞뒤 자세', small_step: '작은 보폭', none: '일반 서기' };

        // 피드백 업데이트
        if (analysis.stanceType !== 'none') {
          const dur = analysis.stanceDuration;
          newFeedback = { message: `${stanceLabels[analysis.stanceType]} ${dur}초 유지 중`, type: 'success' };
        } else {
          newFeedback = { message: '한 발을 다른 발 앞에 일렬로 놓으세요', type: 'info' };
        }

        // 자동 완료: 30초 유지
        if (analysis.maxDuration >= 30) {
          newPhase = 'complete';
          markTandemStanceComplete();
          autoScore = calculateTandemStanceScore(
            analysis.bestStanceType, analysis.maxDuration, false
          );
          assessmentReport = generateTandemStanceReport(
            autoScore, analysis.bestStanceType, analysis.maxDuration, analysis.feetXGap
          );
          showResultModal = true;
          newFeedback = { message: `측정 완료! ${analysis.maxDuration}초`, type: 'success' };
        }

        return {
          ...prev,
          testPhase: newPhase,
          isStanding: analysis.isStanding,
          stanceType: analysis.stanceType,
          bestStanceType: analysis.bestStanceType,
          stanceDuration: analysis.stanceDuration,
          maxDuration: analysis.maxDuration,
          feetXGap: analysis.feetXGap,
          feetYGap: analysis.feetYGap,
          frontFoot: analysis.frontFoot,
          autoScore,
          assessmentReport,
          showResultModal,
          feedback: newFeedback
        };
      }

      return prev;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tandemStanceState.testPhase]);

  // 항목 14 전용 분석 - 한 발로 서기
  const handleItem14Analysis = useCallback((landmarks) => {
    const now = Date.now();

    setSingleLegState(prev => {
      let newPhase = prev.testPhase;
      let newFeedback = prev.feedback;
      let readyConfirmedAt = prev.readyConfirmedAt;
      let autoScore = prev.autoScore;
      let assessmentReport = prev.assessmentReport;
      let showResultModal = prev.showResultModal;

      // waiting: 서있기 감지 후 0.3초 → measuring
      if (prev.testPhase === 'waiting') {
        if (!landmarks || landmarks.length < 33) return prev;

        const lShoulder = landmarks[11], rShoulder = landmarks[12];
        const lHip = landmarks[23], rHip = landmarks[24];
        const lAnkle = landmarks[27], rAnkle = landmarks[28];
        const shoulderY = (lShoulder.y + rShoulder.y) / 2;
        const hipY = (lHip.y + rHip.y) / 2;
        const ankleY = (lAnkle.y + rAnkle.y) / 2;
        const denom = ankleY - shoulderY;
        const hipToAnkleRatio = denom > 0.001 ? (ankleY - hipY) / denom : 0;
        const isStanding = hipToAnkleRatio > 0.45;

        if (isStanding) {
          if (!readyConfirmedAt) {
            readyConfirmedAt = now;
            recordSingleLegStanceInitial(landmarks);
            newFeedback = { message: '서 있는 자세 감지! 준비 중...', type: 'info' };
          } else if (now - readyConfirmedAt > 300) {
            newPhase = 'measuring';
            newFeedback = { message: '한 발을 들어주세요!', type: 'success' };
          }
        } else {
          readyConfirmedAt = null;
          newFeedback = { message: '바르게 서 주세요', type: 'info' };
        }

        return { ...prev, testPhase: newPhase, readyConfirmedAt, feedback: newFeedback };
      }

      // measuring: 매 프레임 분석
      if (prev.testPhase === 'measuring') {
        const analysis = analyzeSingleLegStance(landmarks);
        if (!analysis) return prev;

        // 피드백
        if (analysis.liftedFoot) {
          const footLabel = analysis.liftedFoot === 'left' ? '왼발' : '오른발';
          newFeedback = { message: `${footLabel} 들기 ${analysis.liftDuration}초`, type: 'success' };
        } else if (analysis.maxDuration > 0) {
          newFeedback = { message: `최대 ${analysis.maxDuration}초 — 다시 한 발을 들어주세요`, type: 'info' };
        } else {
          newFeedback = { message: '한 발을 들어주세요', type: 'info' };
        }

        // 자동 완료: 10초 달성
        if (analysis.maxDuration >= 10) {
          newPhase = 'complete';
          markSingleLegStanceComplete();
          autoScore = calculateSingleLegStanceScore(analysis.maxDuration, true, false);
          assessmentReport = generateSingleLegStanceReport(
            autoScore, analysis.maxDuration, analysis.bestLiftedFoot
          );
          showResultModal = true;
          newFeedback = { message: `측정 완료! ${analysis.maxDuration}초`, type: 'success' };
        }

        return {
          ...prev,
          testPhase: newPhase,
          isStanding: analysis.isStanding,
          liftedFoot: analysis.liftedFoot,
          liftDuration: analysis.liftDuration,
          maxDuration: analysis.maxDuration,
          bestLiftedFoot: analysis.bestLiftedFoot,
          autoScore,
          assessmentReport,
          showResultModal,
          feedback: newFeedback
        };
      }

      return prev;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [singleLegState.testPhase]);

  // 일반 항목 분석
  const handleGeneralAnalysis = useCallback((landmarks) => {
    if (!currentBBSItem) return;

    const leftHip = landmarks[23];
    const rightHip = landmarks[24];
    const leftAnkle = landmarks[27];
    const rightAnkle = landmarks[28];
    const leftShoulder = landmarks[11];
    const rightShoulder = landmarks[12];

    const hipY = (leftHip.y + rightHip.y) / 2;
    const ankleY = (leftAnkle.y + rightAnkle.y) / 2;
    const shoulderY = (leftShoulder.y + rightShoulder.y) / 2;
    const hipToAnkleRatio = (ankleY - hipY) / (ankleY - shoulderY);
    const isStanding = hipToAnkleRatio > 0.5;
    const isSitting = hipToAnkleRatio < 0.4;
    const ankleDistance = Math.abs(leftAnkle.x - rightAnkle.x);

    const detection = currentBBSItem.detection;
    let status = '감지 중';
    let confidence = 0;
    let suggestedScore = null;
    let message = '';

    switch (detection.type) {
      case 'standing_duration':
      case 'standing_feet_together':
        if (isStanding) {
          const elapsed = itemTimer;
          const required = currentBBSItem.duration || 120;
          confidence = Math.min(100, (elapsed / required) * 100);
          status = `서 있음 (${Math.floor(elapsed)}초)`;
          message = `${required}초 유지하세요`;

          if (detection.type === 'standing_feet_together' && ankleDistance > 0.15) {
            message = '발을 더 모아주세요';
            confidence = Math.max(0, confidence - 20);
          }

          if (elapsed >= required) {
            suggestedScore = 4;
            status = '완료!';
          } else if (elapsed >= required * 0.5) {
            suggestedScore = 3;
          }
        } else {
          status = '서 주세요';
          confidence = 0;
        }
        break;

      case 'sitting_duration':
        if (isSitting) {
          const elapsed = itemTimer;
          const required = currentBBSItem.duration || 120;
          confidence = Math.min(100, (elapsed / required) * 100);
          status = `앉아 있음 (${Math.floor(elapsed)}초)`;
          message = `${required}초 유지하세요`;

          if (elapsed >= required) {
            suggestedScore = 4;
            status = '완료!';
          }
        } else {
          status = '앉아 주세요';
          confidence = 0;
        }
        break;

      case 'stand_to_sit':
        if (isStanding) {
          status = '서 있음 감지';
          message = '앉으세요';
          confidence = 30;
        } else if (isSitting) {
          status = '앉음 감지!';
          message = '잘 하셨습니다!';
          confidence = 100;
          suggestedScore = 4;
        }
        break;

      default:
        status = '동작 수행 중';
        confidence = 50;
        message = currentBBSItem.instruction;
    }

    setGeneralDetection({ status, confidence, suggestedScore, message });
  }, [currentBBSItem, itemTimer]);

  // MediaPipe 초기화
  const initPose = useCallback(async () => {
    setCameraLoading(true);

    try {
      // 기존 animationFrame 정리
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }

      // MediaPipe Pose는 close() 메서드가 없으므로 단순히 null 처리
      if (poseRef.current) {
        poseRef.current = null;
      }

      // 약간의 딜레이 후 초기화 (DOM 준비 대기)
      await new Promise(resolve => setTimeout(resolve, 100));

      // 비디오/캔버스 ref 확인
      if (!videoRef.current || !canvasRef.current) {
        console.error('Video or canvas ref not available');
        setCameraLoading(false);
        return null;
      }

      const { Pose } = await import('@mediapipe/pose');

      const pose = new Pose({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`
      });

      pose.setOptions({
        modelComplexity: 1,
        smoothLandmarks: true,
        enableSegmentation: false,
        minDetectionConfidence: 0.6,
        minTrackingConfidence: 0.6
      });

      pose.onResults((results) => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        canvas.width = videoRef.current?.videoWidth || 640;
        canvas.height = videoRef.current?.videoHeight || 480;

        ctx.save();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(results.image, 0, 0, canvas.width, canvas.height);

        if (results.poseLandmarks) {
          setCurrentLandmarks(results.poseLandmarks);

          // 첫 프레임에서 캘리브레이션 수행
          if (!calibratedRef.current && patientHeightRef.current) {
            const ar = canvas.width / canvas.height;
            calibrate(patientHeightRef.current, results.poseLandmarks, ar);
            calibratedRef.current = true;
          }

          // 스켈레톤 색상 (상태에 따라)
          let skeletonColor = '#3B82F6';
          if (isItem1) {
            const analysis = handleItem1Analysis(results.poseLandmarks);
            skeletonColor = analysis.state === PostureState.SITTING ? '#EAB308' :
                           analysis.state === PostureState.STANDING ? '#10B981' : '#64748B';

            // 각도 정보 그리기
            drawAngleInfo(ctx, analysis, results.poseLandmarks, canvas.width, canvas.height);
          } else if (isItem2) {
            const analysis = handleItem2Analysis(results.poseLandmarks);
            // 안정성에 따른 색상 - 문자열 비교 (null 체크 추가)
            if (analysis && analysis.stability) {
              skeletonColor = analysis.stability === 'excellent' ? '#10B981' :
                             analysis.stability === 'good' ? '#22C55E' :
                             analysis.stability === 'moderate' ? '#EAB308' :
                             analysis.stability === 'poor' ? '#F97316' : '#EF4444';
            }
          } else if (isItem8) {
            const analysis = handleItem8Analysis(results.poseLandmarks);
            if (analysis) {
              skeletonColor = analysis.armRaised ? '#10B981' : '#3B82F6';

              // reaching 단계에서만 손목 근처에 cm 표시
              if (analysis.wristPos && analysis.maxReachCm > 0) {
                const wx = analysis.wristPos.x * canvas.width;
                const wy = analysis.wristPos.y * canvas.height;

                ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
                ctx.beginPath();
                ctx.roundRect(wx - 45, wy - 35, 90, 28, 5);
                ctx.fill();

                ctx.fillStyle = analysis.maxReachCm >= 25 ? '#10B981' : analysis.maxReachCm >= 12.5 ? '#EAB308' : '#F97316';
                ctx.font = 'bold 13px Arial';
                ctx.textAlign = 'center';
                ctx.fillText(`${analysis.currentReachCm}cm`, wx, wy - 17);
              }
            }
          } else if (isItem9) {
            const analysis = handleItem9Analysis(results.poseLandmarks);
            if (analysis) {
              skeletonColor = analysis.isBending ? '#EAB308' : (analysis.isStanding ? '#10B981' : '#3B82F6');

              // 손목 근처에 손목-발목 거리 표시
              if (analysis.wristPos) {
                const wx = analysis.wristPos.x * canvas.width;
                const wy = analysis.wristPos.y * canvas.height;

                ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
                ctx.beginPath();
                ctx.roundRect(wx - 50, wy - 35, 100, 28, 5);
                ctx.fill();

                ctx.fillStyle = analysis.reachedFloor ? '#10B981' : (analysis.wristToAnkleCm <= 5 ? '#EAB308' : '#F97316');
                ctx.font = 'bold 13px Arial';
                ctx.textAlign = 'center';
                ctx.fillText(`${analysis.reachedFloor ? '바닥 도달!' : `${analysis.wristToAnkleCm}cm`}`, wx, wy - 17);
              }
            }
          } else if (isItem10) {
            const analysis = handleItem10Analysis(results.poseLandmarks);
            if (analysis) {
              skeletonColor = analysis.turnDirection !== 'center'
                ? '#EAB308'
                : (analysis.isStanding ? '#10B981' : '#3B82F6');

              // 어깨 중심 근처에 회전 각도 표시
              const lSh = results.poseLandmarks[11];
              const rSh = results.poseLandmarks[12];
              const sx = ((lSh.x + rSh.x) / 2) * canvas.width;
              const sy = ((lSh.y + rSh.y) / 2) * canvas.height;

              ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
              ctx.beginPath();
              ctx.roundRect(sx - 45, sy - 45, 90, 28, 5);
              ctx.fill();

              ctx.fillStyle = analysis.rotationAngle >= 45 ? '#10B981'
                : analysis.rotationAngle >= 30 ? '#EAB308' : '#F97316';
              ctx.font = 'bold 13px Arial';
              ctx.textAlign = 'center';
              ctx.fillText(`회전 ${analysis.rotationAngle}°`, sx, sy - 27);
            }
          } else if (isItem11) {
            handleItem11Analysis(results.poseLandmarks, true);
            skeletonColor = '#3B82F6';
          } else if (isItem12) {
            handleItem12Analysis(results.poseLandmarks);
            skeletonColor = '#EC4899'; // 핑크
          } else if (isItem13) {
            handleItem13Analysis(results.poseLandmarks);
            skeletonColor = '#8B5CF6'; // 보라
          } else if (isItem14) {
            handleItem14Analysis(results.poseLandmarks);
            skeletonColor = '#F59E0B'; // 앰버
          } else {
            handleGeneralAnalysis(results.poseLandmarks);
          }

          // 스켈레톤 그리기
          drawConnections(ctx, results.poseLandmarks, canvas.width, canvas.height, {
            strokeStyle: skeletonColor,
            lineWidth: 3
          });
          drawLandmarks(ctx, results.poseLandmarks, canvas.width, canvas.height, {
            fillStyle: skeletonColor,
            radius: 5
          });
        } else if (isItem11) {
          // 항목 11 전용: 포즈 소실 시에도 분석 호출 (뒷면 통과 추론)
          handleItem11Analysis(null, false);
        }

        ctx.restore();
      });

      poseRef.current = pose;

      const video = videoRef.current;

      // 동영상 업로드 모드
      if (videoUrl) {
        video.src = videoUrl;
        video.muted = true;
        video.playsInline = true;

        // loadeddata 이벤트 대기
        await new Promise((resolve, reject) => {
          video.onloadeddata = () => {
            const canvas = canvasRef.current;
            if (canvas) {
              canvas.width = video.videoWidth || 640;
              canvas.height = video.videoHeight || 480;
            }
            resolve();
          };
          video.onerror = () => reject(new Error('Video load failed'));
          video.load();
        });

        // rAF 루프로 프레임 전송
        const processFrame = async () => {
          if (video.paused || video.ended) return;
          if (poseRef.current && video.readyState >= 2) {
            try {
              await poseRef.current.send({ image: video });
            } catch {
              // 프레임 전송 오류 무시
            }
          }
          // 영상 진행률 업데이트
          if (video.duration > 0) {
            setVideoProgress(Math.round((video.currentTime / video.duration) * 100));
          }
          animationFrameRef.current = requestAnimationFrame(processFrame);
        };

        video.onplay = () => {
          animationFrameRef.current = requestAnimationFrame(processFrame);
        };

        video.onended = () => {
          if (animationFrameRef.current) {
            cancelAnimationFrame(animationFrameRef.current);
            animationFrameRef.current = null;
          }
          setVideoAnalyzing(false);
          setVideoProgress(100);
        };

        await video.play();
        setCameraLoading(false);
        return null;
      }

      // 실시간 카메라 모드
      if (!videoUrl && inputMode === 'camera') {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } }
        });
        mediaStreamRef.current = stream;
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;

        await new Promise(resolve => { video.onloadedmetadata = resolve; });
        const canvas = canvasRef.current;
        if (canvas) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
        }
        await video.play();

        const processFrame = async () => {
          if (poseRef.current && video.readyState >= 2) {
            try { await poseRef.current.send({ image: video }); } catch { /* ignore */ }
          }
          animationFrameRef.current = requestAnimationFrame(processFrame);
        };
        animationFrameRef.current = requestAnimationFrame(processFrame);
        setCameraLoading(false);
        return stream;
      }

      setCameraLoading(false);
      return null;
    } catch (error) {
      console.error('Pose init error:', error);
      setCameraLoading(false);
      return null;
    }
  }, [isItem1, isItem2, isItem8, isItem9, isItem10, isItem11, isItem12, isItem13, isItem14, videoUrl, inputMode, handleItem1Analysis, handleItem2Analysis, handleItem8Analysis, handleItem9Analysis, handleItem10Analysis, handleItem11Analysis, handleItem12Analysis, handleItem13Analysis, handleItem14Analysis, handleGeneralAnalysis]);

  // 항목 시작
  const startItem = async () => {
    setIsAnalyzing(true);
    setItemTimer(0);
    setVideoProgress(0);
    // 업로드 모드면 영상 분석 중 표시
    if (inputMode === 'upload' && videoUrl) {
      setVideoAnalyzing(true);
    } else {
      setVideoAnalyzing(false);
    }
    startTimeRef.current = Date.now();
    analysisHistoryRef.current = [];
    previousAnalysisRef.current = null;

    if (isItem1) {
      // 상태 히스토리 초기화
      resetStateHistory();

      // 음성 관련 초기화
      lastSpokenPhaseRef.current = null;

      // 시작 음성
      setTimeout(() => speak('의자에 앉아주세요', 1.0), 500);

      setSitToStandState({
        testPhase: 'waiting',
        currentPosture: PostureState.UNKNOWN,
        handPosition: HandPosition.UNKNOWN,
        handSupport: HandSupportState.UNKNOWN,
        sittingConfidence: 0,
        standingConfidence: 0,
        kneeAngle: 0,
        hipAngle: 0,
        feedback: { message: '의자에 앉아주세요...', type: 'info' },
        sittingConfirmedAt: null,
        standingDetectedAt: null,
        usedHandsDuringTransition: false,
        handUsageDetectedAt: null,
        autoScore: null,
        assessmentReport: null,
        showResultModal: false,
        debug: null
      });
    }

    if (isItem2) {
      // 2번 항목 상태 초기화
      resetStandingAnalysis();

      // 음성 관련 초기화
      lastSpokenPhaseRef.current = null;

      // 시작 음성
      setTimeout(() => speak('벽이나 지팡이를 잡지 않고 서 계세요', 1.0), 500);

      setStandingState({
        testPhase: 'waiting',
        currentState: 'not_standing',
        stabilityLevel: 'good',
        isStanding: false,
        isUsingSupport: false,
        standingStartTime: null,
        standingDuration: 0,
        targetDuration: 120,
        supportSeekingCount: 0,
        unstableTime: 0,
        lostBalance: false,
        feedback: { message: '지지물 없이 서 주세요...', type: 'info' },
        autoScore: null,
        assessmentReport: null,
        showResultModal: false,
        debug: null
      });
    }

    if (isItem8) {
      resetArmReachAnalysis();
      lastSpokenPhaseRef.current = null;
      setTimeout(() => speak('서서 팔을 앞으로 90도 뻗어주세요', 1.0), 500);
      setArmReachState({
        testPhase: 'waiting',
        isStanding: false,
        armRaised: false,
        shoulderAngle: 0,
        elbowAngle: 0,
        currentReachCm: 0,
        maxReachCm: 0,
        feetMoved: false,
        feetEverMoved: false,
        viewAngle: null,
        readyConfirmedAt: null,
        feedback: { message: '서서 팔을 앞으로 90도 뻗어주세요', type: 'info' },
        autoScore: null,
        assessmentReport: null,
        showResultModal: false
      });
    }

    if (isItem9) {
      resetPickUpAnalysis();
      lastSpokenPhaseRef.current = null;
      setTimeout(() => speak('바닥의 물건을 집기 위해 서 주세요', 1.0), 500);
      setPickUpState({
        testPhase: 'waiting',
        isStanding: false,
        isBending: false,
        bendAngle: 0,
        wristToAnkleCm: 0,
        minWristToAnkleCm: 999,
        reachedFloor: false,
        feetMoved: false,
        feetEverMoved: false,
        readyConfirmedAt: null,
        feedback: { message: '바닥의 물건을 집기 위해 서 주세요', type: 'info' },
        autoScore: null,
        assessmentReport: null,
        showResultModal: false
      });
    }

    if (isItem10) {
      resetLookBehindAnalysis();
      lastSpokenPhaseRef.current = null;
      setTimeout(() => speak('정면을 보고 바르게 서 주세요', 1.0), 500);
      setLookBehindState({
        testPhase: 'waiting',
        isStanding: false,
        rotationAngle: 0,
        turnDirection: 'center',
        leftMaxRotation: 0,
        rightMaxRotation: 0,
        weightShift: 0,
        leftWeightShift: 0,
        rightWeightShift: 0,
        isAtCenter: true,
        feetMoved: false,
        feetEverMoved: false,
        viewAngle: null,
        readyConfirmedAt: null,
        feedback: { message: '정면을 보고 서 주세요', type: 'info' },
        autoScore: null,
        assessmentReport: null,
        showResultModal: false
      });
    }

    if (isItem11) {
      resetTurn360Analysis();
      lastSpokenPhaseRef.current = null;
      setTimeout(() => speak('정면을 보고 바르게 서 주세요', 1.0), 500);
      setTurn360State({
        testFlow: 'waiting',
        phase: 'facing_front',
        widthRatio: 1.0,
        turnDirection: 'unknown',
        poseLost: false,
        poseLostDuration: 0,
        elapsedSec: 0,
        isStanding: false,
        feetMoved: false,
        feetEverMoved: false,
        visibility: 100,
        progress: 0,
        firstTurnResult: null,
        secondTurnResult: null,
        readyConfirmedAt: null,
        pauseStartedAt: null,
        feedback: { message: '정면을 보고 서 주세요', type: 'info' },
        autoScore: null,
        assessmentReport: null,
        showResultModal: false
      });
    }

    if (isItem12) {
      resetStepAlternatingAnalysis();
      lastSpokenPhaseRef.current = null;
      setTimeout(() => speak('발판 앞에 바르게 서 주세요', 1.0), 500);
      setStepAlternatingState({
        testPhase: 'waiting',
        isStanding: false,
        stepCount: 0,
        alternatingCount: 0,
        lastStepFoot: null,
        isLeftUp: false,
        isRightUp: false,
        elapsedSec: 0,
        feetEverMoved: false,
        readyConfirmedAt: null,
        feedback: { message: '발판 앞에 서 주세요', type: 'info' },
        autoScore: null,
        assessmentReport: null,
        showResultModal: false
      });
    }

    if (isItem13) {
      resetTandemStanceAnalysis();
      lastSpokenPhaseRef.current = null;
      setTimeout(() => speak('바르게 서 주세요', 1.0), 500);
      setTandemStanceState({
        testPhase: 'waiting',
        isStanding: false,
        stanceType: 'none',
        bestStanceType: 'none',
        stanceDuration: 0,
        maxDuration: 0,
        feetXGap: 0,
        feetYGap: 0,
        frontFoot: null,
        readyConfirmedAt: null,
        feedback: { message: '바르게 서 주세요', type: 'info' },
        autoScore: null,
        assessmentReport: null,
        showResultModal: false
      });
    }

    if (isItem14) {
      resetSingleLegStanceAnalysis();
      lastSpokenPhaseRef.current = null;
      setTimeout(() => speak('바르게 서 주세요', 1.0), 500);
      setSingleLegState({
        testPhase: 'waiting',
        isStanding: false,
        liftedFoot: null,
        liftDuration: 0,
        maxDuration: 0,
        bestLiftedFoot: null,
        readyConfirmedAt: null,
        feedback: { message: '바르게 서 주세요', type: 'info' },
        autoScore: null,
        assessmentReport: null,
        showResultModal: false
      });
    }

    timerRef.current = setInterval(() => {
      const elapsed = (Date.now() - startTimeRef.current) / 1000;
      setItemTimer(elapsed);
    }, 100);

    await initPose();
  };

  // startItem을 ref에 저장 (업로드 핸들러에서 자동 호출용)
  startItemRef.current = startItem;

  // 카메라 스트림 정리
  const stopCamera = () => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(t => t.stop());
      mediaStreamRef.current = null;
    }
  };

  // 점수 저장
  const handleScore = (score) => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    stopCamera();
    // 비디오 정지
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
      videoRef.current.onplay = null;
      videoRef.current.onended = null;
    }

    const newScores = [...scores];
    newScores[currentItem] = score;
    setScores(newScores);
    setIsAnalyzing(false);
    setItemTimer(0);
    setCurrentLandmarks(null);

    if (currentItem < 13) {
      setCurrentItem(currentItem + 1);
    } else {
      completeTest(newScores);
    }
  };

  // 테스트 완료
  const completeTest = (finalScores) => {
    const totalScore = finalScores.reduce((a, b) => (a || 0) + (b || 0), 0);
    const risk = calculateBBSRisk(totalScore);

    const resultData = {
      id: Date.now(),
      type: 'BBS',
      patient: patientInfo.name || '미입력',
      patientId: patientInfo.id || '-',
      date: new Date().toLocaleDateString(),
      time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }),
      result: `${totalScore}점`,
      risk: risk.label,
      details: { totalScore, scores: finalScores }
    };

    addTestResult(resultData);
    setIsComplete(true);
  };

  const getTotalScore = () => scores.reduce((a, b) => (a || 0) + (b || 0), 0);
  const getRiskLevel = () => calculateBBSRisk(getTotalScore());

  const resetTest = () => {
    setScores(Array(14).fill(null));
    setCurrentItem(0);
    setIsComplete(false);
    setShowSetup(true);
    setPatientInfo({ name: '홍길동', id: 'P-DEMO-001', height: '' });
    setIsAnalyzing(false);
    setItemTimer(0);
    setCurrentLandmarks(null);
    stopCamera();
    // 영상 및 캘리브레이션 초기화 — 모든 항목 URL 해제
    itemVideos.forEach(iv => {
      if (iv.sideUrl) URL.revokeObjectURL(iv.sideUrl);
      if (iv.frontUrl) URL.revokeObjectURL(iv.frontUrl);
    });
    setItemVideos(Array.from({ length: 14 }, () => ({ sideFile: null, sideUrl: null, frontFile: null, frontUrl: null })));
    setInputMode('upload');
    calibratedRef.current = false;
    resetCalibration();
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach(t => t.stop());
        mediaStreamRef.current = null;
      }
      // 모든 항목 영상 URL 해제
      // (cleanup 시점에서 itemVideos ref 접근 — 최초 마운트 값 사용)
      // 음성 중단
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  // 음성 안내 - 단계 변화 시
  const lastSpokenPhaseRef = useRef(null);
  const lastSpokenTimeRef = useRef(null);

  // 항목 1 음성 안내
  useEffect(() => {
    if (!isItem1 || !isAnalyzing) return;

    const phase = sitToStandState.testPhase;

    // 단계별 음성 안내
    if (phase !== lastSpokenPhaseRef.current) {
      lastSpokenPhaseRef.current = phase;

      switch (phase) {
        case 'waiting':
          speak('의자에 앉아주세요', 1.0);
          break;
        case 'sitting_confirmed':
          speak('일어나세요', 1.0);
          break;
        case 'complete':
          if (sitToStandState.usedHandsDuringTransition) {
            speak(`검사 완료. ${sitToStandState.autoScore?.score || 0}점.`, 0.9);
          } else {
            speak(`검사 완료. ${sitToStandState.autoScore?.score || 4}점.`, 0.9);
          }
          break;
      }
    }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isItem1, isAnalyzing, sitToStandState.testPhase, sitToStandState.autoScore]);

  // 항목 2 음성 안내
  useEffect(() => {
    if (!isItem2 || !isAnalyzing) return;

    const phase = standingState.testPhase;
    const duration = standingState.standingDuration;

    // 단계별 음성 안내
    if (phase !== lastSpokenPhaseRef.current) {
      lastSpokenPhaseRef.current = phase;

      switch (phase) {
        case 'waiting':
          speak('지지물 없이 서 계세요', 1.0);
          break;
        case 'timing':
          speak('좋습니다. 지지 없이 자세를 유지하세요.', 1.0);
          break;
        case 'complete':
          speak(`검사 완료. ${standingState.autoScore?.score || 0}점.`, 0.9);
          break;
      }
    }

    // 시간 안내 (30초, 60초, 90초, 2분)
    if (phase === 'timing') {
      const timeMarkers = [30, 60, 90, 120];
      for (const marker of timeMarkers) {
        if (duration >= marker && duration < marker + 1 && lastSpokenTimeRef.current !== marker) {
          lastSpokenTimeRef.current = marker;
          if (marker === 120) {
            speak('2분 완료!', 1.0);
          } else if (marker === 90) {
            speak('90초. 조금만 더요.', 1.0);
          } else if (marker === 60) {
            speak('1분 경과. 절반 왔어요.', 1.0);
          } else if (marker === 30) {
            speak('30초 경과.', 1.0);
          }
          break;
        }
      }
    }

  }, [isItem2, isAnalyzing, standingState.testPhase, standingState.standingDuration, standingState.autoScore]);

  // 항목 8 음성 안내
  useEffect(() => {
    if (!isItem8 || !isAnalyzing) return;

    const phase = armReachState.testPhase;

    if (phase !== lastSpokenPhaseRef.current) {
      lastSpokenPhaseRef.current = phase;

      switch (phase) {
        case 'waiting':
          speak('서서 팔을 앞으로 90도 뻗어주세요', 1.0);
          break;
        case 'reaching':
          speak('측정 시작. 최대한 앞으로 뻗으세요. 발은 제자리에 두세요.', 1.0);
          break;
        case 'complete':
          speak(`측정 완료. ${armReachState.autoScore?.score || 0}점. 최대 ${armReachState.maxReachCm}센티미터.`, 0.9);
          break;
      }
    }
  }, [isItem8, isAnalyzing, armReachState.testPhase, armReachState.autoScore, armReachState.maxReachCm]);

  // 항목 9 음성 안내
  useEffect(() => {
    if (!isItem9 || !isAnalyzing) return;

    const phase = pickUpState.testPhase;

    if (phase !== lastSpokenPhaseRef.current) {
      lastSpokenPhaseRef.current = phase;

      switch (phase) {
        case 'waiting':
          speak('바닥의 물건을 집기 위해 서 주세요', 1.0);
          break;
        case 'bending':
          speak('측정 시작. 허리를 굽혀 바닥의 물건을 집으세요. 발은 제자리에 두세요.', 1.0);
          break;
        case 'complete':
          speak(`측정 완료. ${pickUpState.autoScore?.score || 0}점.`, 0.9);
          break;
      }
    }
  }, [isItem9, isAnalyzing, pickUpState.testPhase, pickUpState.autoScore]);

  // 항목 10 음성 안내
  useEffect(() => {
    if (!isItem10 || !isAnalyzing) return;

    const phase = lookBehindState.testPhase;

    if (phase !== lastSpokenPhaseRef.current) {
      lastSpokenPhaseRef.current = phase;

      switch (phase) {
        case 'waiting':
          speak('정면을 보고 바르게 서 주세요', 1.0);
          break;
        case 'measuring':
          speak('측정 시작. 왼쪽 어깨 너머로 뒤를 돌아보세요. 그 다음 오른쪽으로 돌아보세요.', 0.9);
          break;
        case 'complete':
          speak(`측정 완료. ${lookBehindState.autoScore?.score || 0}점.`, 0.9);
          break;
      }
    }
  }, [isItem10, isAnalyzing, lookBehindState.testPhase, lookBehindState.autoScore]);

  // 항목 11 음성 안내
  useEffect(() => {
    if (!isItem11 || !isAnalyzing) return;

    const flow = turn360State.testFlow;

    if (flow !== lastSpokenPhaseRef.current) {
      lastSpokenPhaseRef.current = flow;

      switch (flow) {
        case 'waiting':
          speak('정면을 보고 바르게 서 주세요', 1.0);
          break;
        case 'measuring_first':
          speak('측정 시작. 한쪽 방향으로 360도 제자리에서 돌아주세요.', 0.9);
          break;
        case 'pausing':
          speak('1차 회전 완료. 잠시 후 반대 방향으로 돌아주세요.', 0.9);
          break;
        case 'measuring_second':
          speak('반대 방향으로 360도 돌아주세요.', 0.9);
          break;
        case 'complete':
          speak(`측정 완료. ${turn360State.autoScore?.score || 0}점.`, 0.9);
          break;
      }
    }
  }, [isItem11, isAnalyzing, turn360State.testFlow, turn360State.autoScore]);

  // 항목 12 음성 안내
  useEffect(() => {
    if (!isItem12 || !isAnalyzing) return;

    const phase = stepAlternatingState.testPhase;

    if (phase !== lastSpokenPhaseRef.current) {
      lastSpokenPhaseRef.current = phase;

      switch (phase) {
        case 'waiting':
          speak('발판 앞에 바르게 서 주세요', 1.0);
          break;
        case 'measuring':
          speak('시작! 발을 번갈아 올려주세요.', 0.9);
          break;
        case 'complete':
          speak(`측정 완료. ${stepAlternatingState.autoScore?.score || 0}점.`, 0.9);
          break;
      }
    }
  }, [isItem12, isAnalyzing, stepAlternatingState.testPhase, stepAlternatingState.autoScore]);

  // 항목 13 음성 안내
  useEffect(() => {
    if (!isItem13 || !isAnalyzing) return;

    const phase = tandemStanceState.testPhase;

    if (phase !== lastSpokenPhaseRef.current) {
      lastSpokenPhaseRef.current = phase;

      switch (phase) {
        case 'waiting':
          speak('바르게 서 주세요', 1.0);
          break;
        case 'measuring':
          speak('한 발을 다른 발 바로 앞에 일렬로 놓으세요.', 0.9);
          break;
        case 'complete':
          speak(`측정 완료. ${tandemStanceState.autoScore?.score || 0}점.`, 0.9);
          break;
      }
    }
  }, [isItem13, isAnalyzing, tandemStanceState.testPhase, tandemStanceState.autoScore]);

  // 항목 14 음성 안내
  useEffect(() => {
    if (!isItem14 || !isAnalyzing) return;

    const phase = singleLegState.testPhase;

    if (phase !== lastSpokenPhaseRef.current) {
      lastSpokenPhaseRef.current = phase;

      switch (phase) {
        case 'waiting':
          speak('바르게 서 주세요', 1.0);
          break;
        case 'measuring':
          speak('아무것도 잡지 않고 한 발로 서세요.', 0.9);
          break;
        case 'complete':
          speak(`측정 완료. ${singleLegState.autoScore?.score || 0}점.`, 0.9);
          break;
      }
    }
  }, [isItem14, isAnalyzing, singleLegState.testPhase, singleLegState.autoScore]);

  // 음성 합성 초기화 (voices 로드)
  useEffect(() => {
    if ('speechSynthesis' in window) {
      // voices가 로드될 때까지 대기
      window.speechSynthesis.getVoices();
      window.speechSynthesis.onvoiceschanged = () => {
        window.speechSynthesis.getVoices();
      };
    }
  }, []);

  // 영상 업로드 핸들러 — 현재 항목(currentItem) 기반
  const curVid = itemVideos[currentItem] || {};
  const [pendingAutoStart, setPendingAutoStart] = useState(false);

  const handleSideSelect = (file) => {
    const url = URL.createObjectURL(file);
    setItemVideos(prev => {
      const next = [...prev];
      next[currentItem] = { ...next[currentItem], sideFile: file, sideUrl: url };
      return next;
    });
    if (!showSetup) setPendingAutoStart(true);
  };
  const handleSideRemove = () => {
    if (curVid.sideUrl) URL.revokeObjectURL(curVid.sideUrl);
    setItemVideos(prev => {
      const next = [...prev];
      next[currentItem] = { ...next[currentItem], sideFile: null, sideUrl: null };
      return next;
    });
  };
  const handleFrontSelect = (file) => {
    const url = URL.createObjectURL(file);
    setItemVideos(prev => {
      const next = [...prev];
      next[currentItem] = { ...next[currentItem], frontFile: file, frontUrl: url };
      return next;
    });
    if (!showSetup) setPendingAutoStart(true);
  };
  const handleFrontRemove = () => {
    if (curVid.frontUrl) URL.revokeObjectURL(curVid.frontUrl);
    setItemVideos(prev => {
      const next = [...prev];
      next[currentItem] = { ...next[currentItem], frontFile: null, frontUrl: null };
      return next;
    });
  };

  // 영상 업로드 후 자동 분석 시작 (state 반영 후 실행)
  useEffect(() => {
    if (pendingAutoStart && videoUrl && !isAnalyzing && !showSetup) {
      setPendingAutoStart(false);
      if (startItemRef.current) startItemRef.current();
    }
  }, [pendingAutoStart, videoUrl, isAnalyzing, showSetup]);

  // 영상 재생 종료 시 강제 점수 계산
  useEffect(() => {
    const wasAnalyzing = prevVideoAnalyzingRef.current;
    prevVideoAnalyzingRef.current = videoAnalyzing;

    // videoAnalyzing이 true→false로 전환되고 아직 분석 중일 때만 실행
    if (!wasAnalyzing || videoAnalyzing || !isAnalyzing) return;

    // 마지막 프레임의 state 업데이트 반영을 위해 약간의 딜레이
    const timer = setTimeout(() => {
      if (isItem1) {
        setSitToStandState(prev => {
          if (prev.showResultModal || prev.testPhase === 'complete') return prev;
          const history = analysisHistoryRef.current;
          const scoreResult = calculateSitToStandScore(history);
          const report = generateAssessmentReport(history, scoreResult);
          return { ...prev, testPhase: 'complete', autoScore: scoreResult, assessmentReport: report, showResultModal: true, feedback: { message: '영상 분석 완료', type: 'success' } };
        });
      }
      if (isItem2) {
        setStandingState(prev => {
          if (prev.showResultModal || prev.testPhase === 'complete') return prev;
          const scoreResult = calculateStandingScore(prev.standingDuration, prev.supportSeekingCount > 5, prev.lostBalance, prev.unstableTime, 1);
          const report = generateStandingReport(scoreResult.score, prev.standingDuration, { supportEvents: prev.supportSeekingCount });
          return { ...prev, testPhase: 'complete', autoScore: scoreResult, assessmentReport: report, showResultModal: true, feedback: { message: '영상 분석 완료', type: 'success' } };
        });
      }
      if (isItem8) {
        setArmReachState(prev => {
          if (prev.showResultModal || prev.testPhase === 'complete') return prev;
          markArmReachComplete();
          const scoreResult = calculateArmReachScore(prev.maxReachCm, prev.feetEverMoved, false);
          const report = generateArmReachReport(scoreResult, prev.maxReachCm, prev.feetEverMoved);
          return { ...prev, testPhase: 'complete', autoScore: scoreResult, assessmentReport: report, showResultModal: true, feedback: { message: `영상 분석 완료! 최대 ${prev.maxReachCm}cm`, type: 'success' } };
        });
      }
      if (isItem9) {
        setPickUpState(prev => {
          if (prev.showResultModal || prev.testPhase === 'complete') return prev;
          markPickUpComplete();
          const minDist = prev.minWristToAnkleCm >= 999 ? 0 : Math.max(0, prev.minWristToAnkleCm);
          const reached = prev.reachedFloor;
          const scoreResult = calculatePickUpScore(minDist, reached, prev.feetEverMoved, false);
          const report = generatePickUpReport(scoreResult, minDist, reached, prev.feetEverMoved);
          return { ...prev, testPhase: 'complete', autoScore: scoreResult, assessmentReport: report, showResultModal: true, feedback: { message: '영상 분석 완료', type: 'success' } };
        });
      }
      if (isItem10) {
        setLookBehindState(prev => {
          if (prev.showResultModal || prev.testPhase === 'complete') return prev;
          markLookBehindComplete();
          const scoreResult = calculateLookBehindScore(prev.leftMaxRotation, prev.rightMaxRotation, prev.leftWeightShift, prev.rightWeightShift, prev.feetEverMoved, false);
          const report = generateLookBehindReport(scoreResult, prev.leftMaxRotation, prev.rightMaxRotation, prev.leftWeightShift, prev.rightWeightShift, prev.feetEverMoved);
          return { ...prev, testPhase: 'complete', autoScore: scoreResult, assessmentReport: report, showResultModal: true, feedback: { message: '영상 분석 완료', type: 'success' } };
        });
      }
      if (isItem11) {
        setTurn360State(prev => {
          if (prev.showResultModal || prev.testFlow === 'complete') return prev;
          markTurn360Complete();
          const scoreResult = calculateTurn360Score(prev.firstTurnResult, prev.secondTurnResult, prev.feetEverMoved);
          const report = generateTurn360Report(scoreResult, prev.firstTurnResult, prev.secondTurnResult, prev.feetEverMoved);
          return { ...prev, testFlow: 'complete', autoScore: scoreResult, assessmentReport: report, showResultModal: true, feedback: { message: '영상 분석 완료', type: 'success' } };
        });
      }
      if (isItem12) {
        setStepAlternatingState(prev => {
          if (prev.showResultModal || prev.testPhase === 'complete') return prev;
          markStepAlternatingComplete();
          const scoreResult = calculateStepAlternatingScore(
            prev.stepCount, prev.alternatingCount, prev.elapsedSec, false
          );
          const report = generateStepAlternatingReport(
            scoreResult, prev.stepCount, prev.alternatingCount, prev.elapsedSec
          );
          return { ...prev, testPhase: 'complete', autoScore: scoreResult, assessmentReport: report, showResultModal: true, feedback: { message: '영상 분석 완료', type: 'success' } };
        });
      }
      if (isItem13) {
        setTandemStanceState(prev => {
          if (prev.showResultModal || prev.testPhase === 'complete') return prev;
          markTandemStanceComplete();
          const scoreResult = calculateTandemStanceScore(
            prev.bestStanceType, prev.maxDuration, false
          );
          const report = generateTandemStanceReport(
            scoreResult, prev.bestStanceType, prev.maxDuration, prev.feetXGap
          );
          return { ...prev, testPhase: 'complete', autoScore: scoreResult, assessmentReport: report, showResultModal: true, feedback: { message: '영상 분석 완료', type: 'success' } };
        });
      }
      if (isItem14) {
        setSingleLegState(prev => {
          if (prev.showResultModal || prev.testPhase === 'complete') return prev;
          markSingleLegStanceComplete();
          const attempted = prev.maxDuration > 0;
          const scoreResult = calculateSingleLegStanceScore(prev.maxDuration, attempted, false);
          const report = generateSingleLegStanceReport(
            scoreResult, prev.maxDuration, prev.bestLiftedFoot
          );
          return { ...prev, testPhase: 'complete', autoScore: scoreResult, assessmentReport: report, showResultModal: true, feedback: { message: '영상 분석 완료', type: 'success' } };
        });
      }
    }, 300);

    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoAnalyzing, isAnalyzing]);

  // Setup 화면
  if (showSetup) {
    return (
      <PageContainer>
        <Header title="BBS 검사" onBack={() => navigateTo(PAGES.HOME)} />
        <main className="max-w-4xl mx-auto px-4 py-8">
          <div className="space-y-6">
            <Card padding="md">
              <h3 className="text-white font-semibold mb-4">Berg Balance Scale (BBS)</h3>
              <div className="text-slate-400 text-sm space-y-2">
                <p>14개의 균형 능력 항목을 AI가 자동으로 감지하여 평가합니다.</p>
                <p>MediaPipe Pose를 사용하여 영상 기반 모션을 분석합니다.</p>
              </div>
              <Alert type="info" className="mt-4">
                <strong>판정 기준:</strong> 41-56점(낙상 위험 낮음), 21-40점(낙상 위험 있음), 0-20점(낙상 위험 높음)
              </Alert>
            </Card>

            <Card padding="md">
              <h3 className="text-white font-semibold mb-4">환자 정보</h3>
              <PatientInfoForm
                patientInfo={patientInfo}
                onChange={setPatientInfo}
                accentColor="blue"
              />
            </Card>

            <Card padding="md">
              <h3 className="text-white font-semibold mb-4">입력 방식</h3>
              <div className="flex rounded-lg overflow-hidden border border-slate-600">
                <button
                  className={`flex-1 py-3 text-sm font-medium transition-colors ${
                    inputMode === 'upload'
                      ? 'bg-blue-500 text-white'
                      : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                  }`}
                  onClick={() => setInputMode('upload')}
                >
                  영상 업로드
                </button>
                <button
                  className={`flex-1 py-3 text-sm font-medium transition-colors ${
                    inputMode === 'camera'
                      ? 'bg-blue-500 text-white'
                      : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                  }`}
                  onClick={() => setInputMode('camera')}
                >
                  실시간 카메라
                </button>
              </div>
            </Card>

            {inputMode === 'camera' && (
              <Card padding="md">
                <div className="text-center py-6 space-y-3">
                  <div className="w-16 h-16 mx-auto bg-blue-500/20 rounded-full flex items-center justify-center">
                    <svg className="w-8 h-8 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                  </div>
                  <p className="text-white font-medium">후면 카메라를 사용합니다</p>
                  <p className="text-slate-400 text-sm">검사 시작 시 카메라 권한을 요청합니다.<br/>전신이 보이도록 기기를 배치해주세요.</p>
                </div>
              </Card>
            )}

            {inputMode === 'upload' && (
              <Card padding="md">
                <div className="text-center py-4 space-y-2">
                  <p className="text-white font-medium">각 항목별로 영상을 업로드합니다</p>
                  <p className="text-slate-400 text-sm">각 항목 화면에서 해당 항목의 영상을 올리고 분석할 수 있습니다.</p>
                </div>
              </Card>
            )}

            <Button
              variant="bbs"
              size="lg"
              fullWidth
              onClick={() => { patientHeightRef.current = patientInfo.height; setShowSetup(false); }}
            >
              검사 시작
            </Button>
          </div>
        </main>
      </PageContainer>
    );
  }

  // 완료 화면
  if (isComplete) {
    const risk = getRiskLevel();
    const riskColors = getRiskColorClasses(risk.level);

    return (
      <PageContainer>
        <Header title="BBS 검사 결과" showBack={false} />
        <main className="max-w-4xl mx-auto px-4 py-8">
          <div className="text-center space-y-6">
            <div className="w-20 h-20 bg-blue-500/20 rounded-full flex items-center justify-center mx-auto">
              <svg className="w-10 h-10 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>

            <h2 className="text-2xl font-bold text-white">검사 완료</h2>

            <Card padding="md" className="max-w-md mx-auto">
              <div className="text-center mb-6">
                <p className="text-slate-400 text-sm mb-1">총점</p>
                <p className="text-5xl font-bold text-white">
                  {getTotalScore()}<span className="text-xl text-slate-400 ml-1">/ 56점</span>
                </p>
              </div>

              <div className={`p-4 rounded-xl ${riskColors.bg} border ${riskColors.border}`}>
                <p className={`font-semibold ${riskColors.text}`}>낙상 위험도: {risk.label}</p>
              </div>

              <div className="mt-6 space-y-2 max-h-60 overflow-y-auto">
                {BBS_ITEMS.map((item, idx) => (
                  <div key={item.id} className="flex justify-between items-center p-2 bg-slate-800/50 rounded-lg">
                    <span className="text-slate-400 text-sm">{item.id}. {item.shortName}</span>
                    {scores[idx] !== null ? (
                      <span className="text-white font-medium">{scores[idx]}점</span>
                    ) : (
                      <span className="text-yellow-400 text-sm">건너뜀</span>
                    )}
                  </div>
                ))}
              </div>
            </Card>

            <div className="flex gap-4 justify-center">
              <Button variant="secondary" onClick={() => navigateTo(PAGES.HOME)}>홈으로</Button>
              <Button variant="bbs" onClick={resetTest}>다시 검사</Button>
            </div>
          </div>
        </main>
      </PageContainer>
    );
  }

  // 항목 1 전용 UI - 단계별 검사 시스템
  if (isItem1) {
    const phaseLabels = {
      waiting: { text: '1단계: 앉은 자세 대기', color: 'bg-slate-600' },
      sitting_confirmed: { text: '2단계: 일어서기 준비', color: 'bg-yellow-500' },
      standing_up: { text: '3단계: 일어서는 중', color: 'bg-blue-500' },
      complete: { text: '검사 완료!', color: 'bg-emerald-500' }
    };

    const currentPhase = phaseLabels[sitToStandState.testPhase] || phaseLabels.waiting;

    return (
      <PageContainer>
        <Header title="항목 1 / 14" onBack={() => navigateTo(PAGES.HOME)} />

        <main className="max-w-4xl mx-auto px-4 py-8">
          <div className="space-y-4">
            {/* 진행률 */}
            <ProgressBar progress={(1 / 14) * 100} color="blue" height="md" />

            {/* 단계 표시 */}
            {isAnalyzing && (
              <div className="flex items-center justify-between">
                <div className={`px-4 py-2 rounded-full ${currentPhase.color} text-white font-bold`}>
                  {currentPhase.text}
                </div>
                {sitToStandState.usedHandsDuringTransition && (
                  <div className="px-4 py-2 rounded-full bg-red-500 text-white font-bold animate-pulse">
                    ⚠️ 손 사용 감지됨 (감점)
                  </div>
                )}
              </div>
            )}

            {/* 항목 정보 */}
            <Card padding="md">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="text-white font-bold text-lg">1. 앉은 자세에서 일어서기</h3>
                  <p className="text-slate-400 text-sm">손을 사용하지 않고 일어서기</p>
                </div>
                <Badge variant="testType" value="BBS" size="md">AI 자동</Badge>
              </div>

              <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg text-sm">
                <p className="text-blue-400 mb-2"><strong>검사 순서:</strong></p>
                <ol className="text-slate-400 space-y-1 list-decimal list-inside">
                  <li className={sitToStandState.testPhase !== 'waiting' ? 'text-emerald-400' : ''}>
                    의자에 앉기 → AI가 앉은 자세 확인
                  </li>
                  <li className={sitToStandState.testPhase === 'standing_up' || sitToStandState.testPhase === 'complete' ? 'text-emerald-400' : ''}>
                    손 사용하지 않고 일어서기
                  </li>
                  <li className={sitToStandState.testPhase === 'complete' ? 'text-emerald-400' : ''}>
                    서있는 자세 확인 → 자동 채점
                  </li>
                </ol>
              </div>
            </Card>

            {/* 항목별 영상 업로드 */}
            {inputMode === 'upload' && !isAnalyzing && (
              <DualVideoUpload
                sideFile={curVid.sideFile}
                sideUrl={curVid.sideUrl}
                onSideSelect={handleSideSelect}
                onSideRemove={handleSideRemove}
                frontFile={curVid.frontFile}
                frontUrl={curVid.frontUrl}
                onFrontSelect={handleFrontSelect}
                onFrontRemove={handleFrontRemove}
                accentColor="blue"
              />
            )}

            {/* 카메라 뷰 */}
            <div className="aspect-video bg-slate-800 rounded-2xl overflow-hidden relative">
              <video ref={videoRef} className="hidden" playsInline />
              <canvas ref={canvasRef} className="w-full h-full object-contain" />

              {/* 카메라 시작 전 */}
              {!isAnalyzing && !cameraLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-900/80">
                  <div className="text-center space-y-4">
                    <div className="w-24 h-24 mx-auto rounded-full bg-blue-500/20 flex items-center justify-center">
                      <svg className="w-12 h-12 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    </div>
                    <p className="text-slate-300">{inputMode === 'upload' && !videoUrl ? '위에서 영상을 업로드하세요' : '전신이 보이도록 카메라를 배치해주세요'}</p>
                    <Button variant="bbs" size="lg" onClick={startItem} disabled={inputMode === 'upload' && !videoUrl}>
                      {inputMode === 'upload' && !videoUrl ? '영상을 먼저 업로드하세요' : '검사 시작'}
                    </Button>
                  </div>
                </div>
              )}

              {/* 영상 분석 중 표시 */}
              {videoAnalyzing && isAnalyzing && (
                <div className="absolute top-0 left-0 right-0 bg-blue-600/90 backdrop-blur-sm px-4 py-2 z-10">
                  <div className="flex items-center gap-3">
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span className="text-white font-medium text-sm">동영상 분석 중...</span>
                    <span className="text-blue-200 text-sm ml-auto">{videoProgress}%</span>
                  </div>
                  <div className="w-full bg-blue-800 rounded-full h-1.5 mt-1">
                    <div className="bg-white h-1.5 rounded-full transition-all" style={{ width: `${videoProgress}%` }} />
                  </div>
                </div>
              )}

              {/* 카메라 로딩 중 */}
              {cameraLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-900/80">
                  <div className="text-center space-y-4">
                    <div className="w-16 h-16 mx-auto border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
                    <p className="text-slate-300">카메라 초기화 중...</p>
                  </div>
                </div>
              )}

              {/* 분석 중 오버레이 */}
              {isAnalyzing && !cameraLoading && (
                <>
                  {/* 상단 좌측: 자세 상태 */}
                  <div className="absolute top-4 left-4 space-y-2">
                    <div className={`px-4 py-2 rounded-xl backdrop-blur-sm shadow-lg ${
                      sitToStandState.currentPosture === PostureState.SITTING ? 'bg-yellow-500' :
                      sitToStandState.currentPosture === PostureState.STANDING ? 'bg-emerald-500' :
                      'bg-slate-600'
                    }`}>
                      <p className="text-white font-bold text-xl">
                        {sitToStandState.currentPosture === PostureState.SITTING && '🪑 앉음'}
                        {sitToStandState.currentPosture === PostureState.STANDING && '🧍 서있음'}
                        {sitToStandState.currentPosture === PostureState.UNKNOWN && '👀 감지 중'}
                      </p>
                    </div>

                    {/* 손 상태 */}
                    <div className={`px-3 py-2 rounded-lg backdrop-blur-sm ${
                      sitToStandState.handSupport === HandSupportState.HEAVY_SUPPORT ? 'bg-red-500 animate-pulse' :
                      sitToStandState.handPosition === HandPosition.HANDS_UP ? 'bg-emerald-500/80' :
                      'bg-slate-700/80'
                    }`}>
                      <p className="text-white font-medium text-sm">
                        {sitToStandState.handSupport === HandSupportState.HEAVY_SUPPORT && '⚠️ 손 사용! (감점)'}
                        {sitToStandState.handSupport !== HandSupportState.HEAVY_SUPPORT && sitToStandState.handPosition === HandPosition.HANDS_UP && '✓ 손 OK'}
                        {sitToStandState.handSupport !== HandSupportState.HEAVY_SUPPORT && sitToStandState.handPosition === HandPosition.HANDS_ON_KNEE && '손 무릎 위'}
                        {sitToStandState.handSupport !== HandSupportState.HEAVY_SUPPORT && sitToStandState.handPosition === HandPosition.UNKNOWN && '손 감지 중'}
                      </p>
                    </div>
                  </div>

                  {/* 상단 우측: 피드백 메시지 */}
                  <div className={`absolute top-4 right-4 px-4 py-3 rounded-xl backdrop-blur-sm shadow-lg max-w-[250px] ${
                    sitToStandState.feedback.type === 'success' ? 'bg-emerald-500' :
                    sitToStandState.feedback.type === 'error' ? 'bg-red-500' :
                    sitToStandState.feedback.type === 'warning' ? 'bg-yellow-500' :
                    'bg-blue-500'
                  }`}>
                    <p className="text-white font-bold text-lg">{sitToStandState.feedback.message}</p>
                  </div>

                  {/* 하단: 신뢰도 바 */}
                  <div className="absolute bottom-4 left-4 right-4">
                    <div className="bg-slate-900/90 backdrop-blur-sm p-4 rounded-xl">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <div className="flex justify-between text-sm mb-1">
                            <span className="text-yellow-400">앉음</span>
                            <span className="text-white font-bold">{Math.round(sitToStandState.sittingConfidence)}%</span>
                          </div>
                          <div className="w-full bg-slate-700 rounded-full h-4">
                            <div
                              className={`h-4 rounded-full transition-all duration-300 ${
                                sitToStandState.testPhase === 'sitting_confirmed' ? 'bg-yellow-400' : 'bg-yellow-500/50'
                              }`}
                              style={{ width: `${sitToStandState.sittingConfidence}%` }}
                            />
                          </div>
                        </div>
                        <div>
                          <div className="flex justify-between text-sm mb-1">
                            <span className="text-emerald-400">서있음</span>
                            <span className="text-white font-bold">{Math.round(sitToStandState.standingConfidence)}%</span>
                          </div>
                          <div className="w-full bg-slate-700 rounded-full h-4">
                            <div
                              className={`h-4 rounded-full transition-all duration-300 ${
                                sitToStandState.testPhase === 'complete' ? 'bg-emerald-400' : 'bg-emerald-500/50'
                              }`}
                              style={{ width: `${sitToStandState.standingConfidence}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* 단계별 안내 카드 */}
            {isAnalyzing && !sitToStandState.showResultModal && (
              <Card padding="md" className={`border-2 ${
                sitToStandState.testPhase === 'waiting' ? 'border-slate-600' :
                sitToStandState.testPhase === 'sitting_confirmed' ? 'border-yellow-500' :
                sitToStandState.testPhase === 'standing_up' ? 'border-blue-500' :
                'border-emerald-500'
              }`}>
                {sitToStandState.testPhase === 'waiting' && (
                  <div className="text-center py-4">
                    <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-slate-700 flex items-center justify-center">
                      <span className="text-4xl">🪑</span>
                    </div>
                    <h4 className="text-white font-bold text-xl mb-2">의자에 앉아주세요</h4>
                    <p className="text-slate-400">AI가 앉은 자세를 확인하면 다음 단계로 진행됩니다</p>
                    <div className="mt-4 flex items-center justify-center gap-2">
                      <div className="w-3 h-3 bg-blue-500 rounded-full animate-pulse" />
                      <span className="text-blue-400 text-sm">앉은 자세 감지 중...</span>
                    </div>
                  </div>
                )}

                {sitToStandState.testPhase === 'sitting_confirmed' && (
                  <div className="text-center py-4">
                    <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-yellow-500/20 flex items-center justify-center">
                      <span className="text-4xl">✓</span>
                    </div>
                    <h4 className="text-yellow-400 font-bold text-xl mb-2">앉은 자세 확인됨!</h4>
                    <p className="text-white text-lg mb-2">이제 <strong>손을 사용하지 않고</strong> 일어서세요</p>
                    <p className="text-red-400 text-sm">⚠️ 무릎이나 의자를 짚으면 감점됩니다</p>
                  </div>
                )}

                {sitToStandState.testPhase === 'standing_up' && (
                  <div className="text-center py-4">
                    <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-blue-500/20 flex items-center justify-center animate-pulse">
                      <span className="text-4xl">🧍</span>
                    </div>
                    <h4 className="text-blue-400 font-bold text-xl mb-2">일어서는 중...</h4>
                    <p className="text-slate-300">완전히 서면 검사가 자동 종료됩니다</p>
                    {sitToStandState.usedHandsDuringTransition && (
                      <div className="mt-3 p-2 bg-red-500/20 border border-red-500/30 rounded-lg">
                        <p className="text-red-400 font-bold">⚠️ 손 사용이 감지되었습니다</p>
                      </div>
                    )}
                  </div>
                )}
              </Card>
            )}

            {/* 이전 항목 / 건너뛰기 버튼 */}
            {!sitToStandState.showResultModal && (
              <div className="flex justify-end">
                <Button
                  variant="ghost"
                  className="text-yellow-400 border-yellow-500/30 hover:bg-yellow-500/10"
                  onClick={() => {
                    if (timerRef.current) clearInterval(timerRef.current);
                    if (animationFrameRef.current) {
                      cancelAnimationFrame(animationFrameRef.current);
                      animationFrameRef.current = null;
                    }
                    stopCamera();
                    if (videoRef.current) {
                      videoRef.current.pause();
                      videoRef.current.srcObject = null;
                      videoRef.current.onplay = null;
                      videoRef.current.onended = null;
                    }
                    setIsAnalyzing(false);
                    setItemTimer(0);
                    setCurrentLandmarks(null);
                    setCurrentItem(currentItem + 1);
                  }}
                >
                  건너뛰기 →
                </Button>
              </div>
            )}
          </div>
        </main>

        {/* 결과 모달 */}
        {sitToStandState.showResultModal && sitToStandState.assessmentReport && (
          <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-slate-900 rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto border border-slate-700 shadow-2xl">
              {/* 헤더 */}
              <div className={`p-6 text-center ${
                sitToStandState.usedHandsDuringTransition ? 'bg-yellow-500/20' : 'bg-emerald-500/20'
              }`}>
                <div className={`w-20 h-20 mx-auto mb-4 rounded-full flex items-center justify-center ${
                  sitToStandState.usedHandsDuringTransition ? 'bg-yellow-500' : 'bg-emerald-500'
                }`}>
                  <span className="text-4xl">
                    {sitToStandState.usedHandsDuringTransition ? '⚠️' : '✓'}
                  </span>
                </div>
                <h2 className="text-white font-bold text-2xl mb-2">항목 1 검사 완료</h2>
                <p className="text-slate-400">앉은 자세에서 일어서기</p>
              </div>

              {/* 점수 */}
              <div className="p-6 border-b border-slate-700">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-slate-400 text-sm">AI 자동 채점</p>
                    <p className="text-5xl font-bold text-white">
                      {sitToStandState.assessmentReport.scoring.autoScore}
                      <span className="text-xl text-slate-500 ml-1">/ 4점</span>
                    </p>
                  </div>
                  <div className="w-24 h-24 relative">
                    <svg className="w-24 h-24 transform -rotate-90">
                      <circle cx="48" cy="48" r="40" stroke="#334155" strokeWidth="8" fill="none" />
                      <circle
                        cx="48" cy="48" r="40"
                        stroke={sitToStandState.usedHandsDuringTransition ? '#EAB308' : '#10B981'}
                        strokeWidth="8"
                        fill="none"
                        strokeDasharray={`${(sitToStandState.assessmentReport.scoring.autoScore / 4) * 251} 251`}
                        strokeLinecap="round"
                      />
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="text-3xl font-bold text-white">{sitToStandState.assessmentReport.scoring.autoScore}</span>
                    </div>
                  </div>
                </div>
                <p className={`mt-3 text-lg font-medium ${
                  sitToStandState.usedHandsDuringTransition ? 'text-yellow-400' : 'text-emerald-400'
                }`}>
                  {sitToStandState.assessmentReport.scoring.reason}
                </p>
              </div>

              {/* 분석 결과 */}
              <div className="p-6 space-y-4">
                <h3 className="text-white font-bold">AI 분석 결과</h3>

                <div className="grid grid-cols-2 gap-3">
                  <div className="p-3 bg-slate-800 rounded-xl">
                    <p className="text-slate-400 text-xs mb-1">앉은 자세</p>
                    <p className="text-white font-bold text-lg">
                      {sitToStandState.assessmentReport.detection.sittingDetected ? '✓ 감지됨' : '✗ 미감지'}
                    </p>
                    <p className="text-yellow-400 text-sm">{sitToStandState.assessmentReport.detection.sittingConfidence}%</p>
                  </div>
                  <div className="p-3 bg-slate-800 rounded-xl">
                    <p className="text-slate-400 text-xs mb-1">서있는 자세</p>
                    <p className="text-white font-bold text-lg">
                      {sitToStandState.assessmentReport.detection.standingDetected ? '✓ 감지됨' : '✗ 미감지'}
                    </p>
                    <p className="text-emerald-400 text-sm">{sitToStandState.assessmentReport.detection.standingConfidence}%</p>
                  </div>
                </div>

                <div className="p-3 bg-slate-800 rounded-xl">
                  <div className="flex justify-between items-center">
                    <span className="text-slate-400">손 사용 여부</span>
                    <span className={`px-3 py-1 rounded-full font-bold ${
                      sitToStandState.assessmentReport.movement.usedHands
                        ? 'bg-red-500/20 text-red-400'
                        : 'bg-emerald-500/20 text-emerald-400'
                    }`}>
                      {sitToStandState.assessmentReport.movement.usedHands ? '⚠️ 사용함 (감점)' : '✓ 사용 안함'}
                    </span>
                  </div>
                </div>

                <div className="p-3 bg-slate-800 rounded-xl">
                  <div className="flex justify-between items-center">
                    <span className="text-slate-400">검사 소요시간</span>
                    <span className="text-white font-medium">{sitToStandState.assessmentReport.testInfo.duration}</span>
                  </div>
                </div>
              </div>

              {/* 버튼 */}
              <div className="p-6 bg-slate-800/50">
                <Button
                  variant="bbs"
                  size="lg"
                  fullWidth
                  onClick={() => handleScore(sitToStandState.assessmentReport.scoring.autoScore)}
                >
                  다음 항목으로 (항목 2) →
                </Button>
              </div>
            </div>
          </div>
        )}
      </PageContainer>
    );
  }

  // 항목 2 전용 UI - 잡지 않고 서 있기
  if (isItem2) {
    const phaseLabels = {
      waiting: { text: '서 있는 자세 대기', color: 'bg-slate-600' },
      timing: { text: '시간 측정 중', color: 'bg-blue-500' },
      complete: { text: '검사 완료!', color: 'bg-emerald-500' }
    };

    const currentPhase = phaseLabels[standingState.testPhase] || phaseLabels.waiting;
    const progressPercent = Math.min(100, (standingState.standingDuration / standingState.targetDuration) * 100);

    // 안정성 레벨 표시 - 문자열 키 사용
    const stabilityLabels = {
      'excellent': { text: '매우 안정', color: 'text-emerald-400', bg: 'bg-emerald-500' },
      'good': { text: '안정', color: 'text-green-400', bg: 'bg-green-500' },
      'moderate': { text: '약간 흔들림', color: 'text-yellow-400', bg: 'bg-yellow-500' },
      'poor': { text: '불안정', color: 'text-orange-400', bg: 'bg-orange-500' },
      'critical': { text: '매우 불안정', color: 'text-red-400', bg: 'bg-red-500' }
    };

    const currentStability = stabilityLabels[standingState.stabilityLevel] || stabilityLabels['good'];

    return (
      <PageContainer>
        <Header title="항목 2 / 14" onBack={() => navigateTo(PAGES.HOME)} />

        <main className="max-w-4xl mx-auto px-4 py-8">
          <div className="space-y-4">
            {/* 진행률 */}
            <ProgressBar progress={(2 / 14) * 100} color="blue" height="md" />

            {/* 단계 표시 */}
            {isAnalyzing && (
              <div className="flex items-center justify-between">
                <div className={`px-4 py-2 rounded-full ${currentPhase.color} text-white font-bold`}>
                  {currentPhase.text}
                </div>
                <div className={`px-4 py-2 rounded-full ${currentStability.bg} text-white font-bold`}>
                  {currentStability.text}
                </div>
              </div>
            )}

            {/* 항목 정보 */}
            <Card padding="md">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="text-white font-bold text-lg">2. 잡지 않고 서 있기</h3>
                  <p className="text-slate-400 text-sm">2분간 지지 없이 서 있기</p>
                </div>
                <Badge variant="testType" value="BBS" size="md">AI 자동</Badge>
              </div>

              <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg text-sm">
                <p className="text-blue-400 mb-2"><strong>검사 순서:</strong></p>
                <ol className="text-slate-400 space-y-1 list-decimal list-inside">
                  <li className={standingState.testPhase !== 'waiting' ? 'text-emerald-400' : ''}>
                    서 있는 자세 취하기 → AI가 자세 확인
                  </li>
                  <li className={standingState.testPhase === 'complete' ? 'text-emerald-400' : ''}>
                    2분간 자세 유지 → 자동 채점
                  </li>
                </ol>
              </div>
            </Card>

            {/* 항목별 영상 업로드 */}
            {inputMode === 'upload' && !isAnalyzing && (
              <DualVideoUpload
                sideFile={curVid.sideFile}
                sideUrl={curVid.sideUrl}
                onSideSelect={handleSideSelect}
                onSideRemove={handleSideRemove}
                frontFile={curVid.frontFile}
                frontUrl={curVid.frontUrl}
                onFrontSelect={handleFrontSelect}
                onFrontRemove={handleFrontRemove}
                accentColor="blue"
              />
            )}

            {/* 카메라 뷰 */}
            <div className="aspect-video bg-slate-800 rounded-2xl overflow-hidden relative">
              <video ref={videoRef} className="hidden" playsInline />
              <canvas ref={canvasRef} className="w-full h-full object-contain" />

              {/* 카메라 시작 전 */}
              {!isAnalyzing && !cameraLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-900/80">
                  <div className="text-center space-y-4">
                    <div className="w-24 h-24 mx-auto rounded-full bg-blue-500/20 flex items-center justify-center">
                      <svg className="w-12 h-12 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    </div>
                    <p className="text-slate-300">{inputMode === 'upload' && !videoUrl ? '위에서 영상을 업로드하세요' : '전신이 보이도록 카메라를 배치해주세요'}</p>
                    <Button variant="bbs" size="lg" onClick={startItem} disabled={inputMode === 'upload' && !videoUrl}>
                      {inputMode === 'upload' && !videoUrl ? '영상을 먼저 업로드하세요' : '검사 시작'}
                    </Button>
                  </div>
                </div>
              )}

              {/* 영상 분석 중 표시 */}
              {videoAnalyzing && isAnalyzing && (
                <div className="absolute top-0 left-0 right-0 bg-blue-600/90 backdrop-blur-sm px-4 py-2 z-10">
                  <div className="flex items-center gap-3">
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span className="text-white font-medium text-sm">동영상 분석 중...</span>
                    <span className="text-blue-200 text-sm ml-auto">{videoProgress}%</span>
                  </div>
                  <div className="w-full bg-blue-800 rounded-full h-1.5 mt-1">
                    <div className="bg-white h-1.5 rounded-full transition-all" style={{ width: `${videoProgress}%` }} />
                  </div>
                </div>
              )}

              {/* 카메라 로딩 중 */}
              {cameraLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-900/80">
                  <div className="text-center space-y-4">
                    <div className="w-16 h-16 mx-auto border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
                    <p className="text-slate-300">카메라 초기화 중...</p>
                  </div>
                </div>
              )}

              {/* 분석 중 오버레이 */}
              {isAnalyzing && !cameraLoading && (
                <>
                  {/* 상단 좌측: 타이머 */}
                  <div className="absolute top-4 left-4">
                    <div className="bg-slate-900/90 backdrop-blur-sm px-6 py-4 rounded-xl shadow-lg">
                      <p className="text-slate-400 text-sm mb-1">경과 시간</p>
                      <p className="text-white font-mono text-4xl font-bold">
                        {Math.floor(standingState.standingDuration / 60)}:{String(Math.floor(standingState.standingDuration % 60)).padStart(2, '0')}
                      </p>
                      <p className="text-slate-500 text-xs mt-1">목표: 2:00</p>
                    </div>
                  </div>

                  {/* 상단 우측: 피드백 메시지 */}
                  <div className={`absolute top-4 right-4 px-4 py-3 rounded-xl backdrop-blur-sm shadow-lg max-w-[250px] ${
                    standingState.feedback.type === 'success' ? 'bg-emerald-500' :
                    standingState.feedback.type === 'error' ? 'bg-red-500' :
                    standingState.feedback.type === 'warning' ? 'bg-yellow-500' :
                    'bg-blue-500'
                  }`}>
                    <p className="text-white font-bold text-lg">{standingState.feedback.message}</p>
                  </div>

                  {/* 하단: 진행률 바 */}
                  <div className="absolute bottom-4 left-4 right-4">
                    <div className="bg-slate-900/90 backdrop-blur-sm p-4 rounded-xl">
                      <div className="flex justify-between text-sm mb-2">
                        <span className="text-slate-400">진행률</span>
                        <span className="text-white font-bold">{Math.round(progressPercent)}%</span>
                      </div>
                      <div className="w-full bg-slate-700 rounded-full h-6 overflow-hidden">
                        <div
                          className={`h-6 rounded-full transition-all duration-300 flex items-center justify-end pr-2 ${
                            progressPercent >= 100 ? 'bg-emerald-500' :
                            progressPercent >= 50 ? 'bg-blue-500' :
                            'bg-blue-400'
                          }`}
                          style={{ width: `${progressPercent}%` }}
                        >
                          {progressPercent >= 15 && (
                            <span className="text-white text-xs font-bold">
                              {Math.floor(standingState.standingDuration)}초
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex justify-between text-xs text-slate-500 mt-1">
                        <span>0초</span>
                        <span className="text-yellow-400">30초 (최소)</span>
                        <span>2분</span>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* 단계별 안내 카드 */}
            {isAnalyzing && !standingState.showResultModal && (
              <Card padding="md" className={`border-2 ${
                standingState.testPhase === 'waiting' ? 'border-slate-600' :
                standingState.testPhase === 'timing' ? 'border-blue-500' :
                'border-emerald-500'
              }`}>
                {standingState.testPhase === 'waiting' && (
                  <div className="text-center py-4">
                    <div className={`w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center ${
                      standingState.isUsingSupport ? 'bg-yellow-500/20' : 'bg-slate-700'
                    }`}>
                      <span className="text-4xl">{standingState.isUsingSupport ? '🚫' : '🧍'}</span>
                    </div>
                    {standingState.isUsingSupport ? (
                      <>
                        <h4 className="text-yellow-400 font-bold text-xl mb-2">⚠️ 지지물 사용 감지</h4>
                        <p className="text-slate-300">벽, 지팡이, 의자 등의 지지물을 놓아주세요</p>
                        <p className="text-yellow-400/80 text-sm mt-2">지지 없이 서면 타이머가 시작됩니다</p>
                      </>
                    ) : (
                      <>
                        <h4 className="text-white font-bold text-xl mb-2">지지물 없이 서 주세요</h4>
                        <p className="text-slate-400">벽이나 지팡이를 잡지 않고 서면 타이머가 시작됩니다</p>
                      </>
                    )}
                    <div className="mt-4 flex items-center justify-center gap-2">
                      <div className={`w-3 h-3 rounded-full animate-pulse ${
                        standingState.isUsingSupport ? 'bg-yellow-500' : 'bg-blue-500'
                      }`} />
                      <span className={`text-sm ${
                        standingState.isUsingSupport ? 'text-yellow-400' : 'text-blue-400'
                      }`}>
                        {standingState.isUsingSupport ? '지지물 감지됨 - 놓아주세요' : '지지 없이 서 있는 자세 감지 중...'}
                      </span>
                    </div>
                  </div>
                )}

                {standingState.testPhase === 'timing' && (
                  <div className="text-center py-4">
                    <div className={`w-16 h-16 mx-auto mb-4 rounded-full ${currentStability.bg}/20 flex items-center justify-center`}>
                      <span className="text-4xl">⏱️</span>
                    </div>
                    <h4 className={`font-bold text-xl mb-2 ${currentStability.color}`}>
                      {currentStability.text} 상태
                    </h4>
                    <p className="text-white text-lg mb-2">
                      <strong>{Math.floor(standingState.standingDuration)}초</strong> / 120초
                    </p>
                    <p className="text-slate-400 text-sm">
                      {standingState.standingDuration < 30 ? '최소 30초간 유지하세요' :
                       standingState.standingDuration < 120 ? `남은 시간: ${Math.ceil(120 - standingState.standingDuration)}초` :
                       '목표 달성!'}
                    </p>

                    {/* 30초 이상일 때 수동 완료 버튼 */}
                    {standingState.standingDuration >= 30 && standingState.standingDuration < 120 && (
                      <div className="mt-4">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            const score = calculateStandingScore(
                              standingState.standingDuration,
                              standingState.supportSeekingCount > 5,
                              false,
                              standingState.unstableTime,
                              1
                            );
                            const report = generateStandingReport(score.score, standingState.standingDuration, {
                              avgStability: standingState.stabilityLevel,
                              supportEvents: standingState.supportSeekingCount
                            });
                            setStandingState(prev => ({
                              ...prev,
                              testPhase: 'complete',
                              autoScore: score,
                              assessmentReport: report,
                              showResultModal: true
                            }));
                          }}
                        >
                          검사 종료 ({Math.floor(standingState.standingDuration)}초에서 멈추기)
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </Card>
            )}

            {/* 이전 항목 / 건너뛰기 버튼 */}
            {!standingState.showResultModal && (
              <div className="flex justify-between">
                <Button
                  variant="ghost"
                  className="flex-1"
                  onClick={() => {
                    if (timerRef.current) clearInterval(timerRef.current);
                    if (animationFrameRef.current) {
                      cancelAnimationFrame(animationFrameRef.current);
                      animationFrameRef.current = null;
                    }
                    stopCamera();
                    if (videoRef.current) {
                      videoRef.current.pause();
                      videoRef.current.srcObject = null;
                      videoRef.current.onplay = null;
                      videoRef.current.onended = null;
                    }
                    setIsAnalyzing(false);
                    setItemTimer(0);
                    setCurrentLandmarks(null);
                    setCurrentItem(currentItem - 1);
                  }}
                >
                  ← 이전 항목
                </Button>
                <Button
                  variant="ghost"
                  className="flex-1 text-yellow-400 border-yellow-500/30 hover:bg-yellow-500/10"
                  onClick={() => {
                    if (timerRef.current) clearInterval(timerRef.current);
                    if (animationFrameRef.current) {
                      cancelAnimationFrame(animationFrameRef.current);
                      animationFrameRef.current = null;
                    }
                    stopCamera();
                    if (videoRef.current) {
                      videoRef.current.pause();
                      videoRef.current.srcObject = null;
                      videoRef.current.onplay = null;
                      videoRef.current.onended = null;
                    }
                    setIsAnalyzing(false);
                    setItemTimer(0);
                    setCurrentLandmarks(null);
                    setCurrentItem(currentItem + 1);
                  }}
                >
                  건너뛰기 →
                </Button>
              </div>
            )}
          </div>
        </main>

        {/* 결과 모달 */}
        {standingState.showResultModal && standingState.assessmentReport && (
          <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-slate-900 rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto border border-slate-700 shadow-2xl">
              {/* 헤더 */}
              <div className={`p-6 text-center ${
                standingState.assessmentReport.score >= 3 ? 'bg-emerald-500/20' : 'bg-yellow-500/20'
              }`}>
                <div className={`w-20 h-20 mx-auto mb-4 rounded-full flex items-center justify-center ${
                  standingState.assessmentReport.score >= 3 ? 'bg-emerald-500' : 'bg-yellow-500'
                }`}>
                  <span className="text-4xl">
                    {standingState.assessmentReport.score >= 3 ? '✓' : '⚠️'}
                  </span>
                </div>
                <h2 className="text-white font-bold text-2xl mb-2">항목 2 검사 완료</h2>
                <p className="text-slate-400">잡지 않고 서 있기</p>
              </div>

              {/* 점수 */}
              <div className="p-6 border-b border-slate-700">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-slate-400 text-sm">AI 자동 채점</p>
                    <p className="text-5xl font-bold text-white">
                      {standingState.assessmentReport.score}
                      <span className="text-xl text-slate-500 ml-1">/ 4점</span>
                    </p>
                  </div>
                  <div className="w-24 h-24 relative">
                    <svg className="w-24 h-24 transform -rotate-90">
                      <circle cx="48" cy="48" r="40" stroke="#334155" strokeWidth="8" fill="none" />
                      <circle
                        cx="48" cy="48" r="40"
                        stroke={standingState.assessmentReport.score >= 3 ? '#10B981' : '#EAB308'}
                        strokeWidth="8"
                        fill="none"
                        strokeDasharray={`${(standingState.assessmentReport.score / 4) * 251} 251`}
                        strokeLinecap="round"
                      />
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="text-3xl font-bold text-white">{standingState.assessmentReport.score}</span>
                    </div>
                  </div>
                </div>
                <p className={`mt-3 text-lg font-medium ${
                  standingState.assessmentReport.score >= 3 ? 'text-emerald-400' : 'text-yellow-400'
                }`}>
                  {standingState.autoScore?.reason}
                </p>
              </div>

              {/* 분석 결과 */}
              <div className="p-6 space-y-4">
                <h3 className="text-white font-bold">AI 분석 결과</h3>

                <div className="grid grid-cols-2 gap-3">
                  <div className="p-3 bg-slate-800 rounded-xl">
                    <p className="text-slate-400 text-xs mb-1">서 있은 시간</p>
                    <p className="text-white font-bold text-lg">
                      {Math.floor(standingState.standingDuration / 60)}분 {Math.floor(standingState.standingDuration % 60)}초
                    </p>
                    <p className="text-blue-400 text-sm">목표: 2분</p>
                  </div>
                  <div className="p-3 bg-slate-800 rounded-xl">
                    <p className="text-slate-400 text-xs mb-1">안정성</p>
                    <p className="text-white font-bold text-lg">
                      {standingState.assessmentReport.measurements?.avgStability || '양호'}
                    </p>
                  </div>
                </div>

                <div className="p-3 bg-slate-800 rounded-xl">
                  <div className="flex justify-between items-center">
                    <span className="text-slate-400">지지 요청 횟수</span>
                    <span className={`px-3 py-1 rounded-full font-bold ${
                      standingState.supportSeekingCount > 5
                        ? 'bg-yellow-500/20 text-yellow-400'
                        : 'bg-emerald-500/20 text-emerald-400'
                    }`}>
                      {standingState.supportSeekingCount}회
                    </span>
                  </div>
                </div>

                {standingState.assessmentReport.assessment && (
                  <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded-xl">
                    <p className="text-blue-400 text-sm">{standingState.assessmentReport.assessment}</p>
                  </div>
                )}

                {standingState.assessmentReport.recommendations?.length > 0 && (
                  <div className="p-3 bg-slate-800 rounded-xl">
                    <p className="text-slate-400 text-xs mb-2">권장사항</p>
                    <ul className="text-slate-300 text-sm space-y-1">
                      {standingState.assessmentReport.recommendations.map((rec, idx) => (
                        <li key={idx}>• {rec}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {/* 버튼 */}
              <div className="p-6 bg-slate-800/50">
                <Button
                  variant="bbs"
                  size="lg"
                  fullWidth
                  onClick={() => handleScore(standingState.assessmentReport.score)}
                >
                  다음 항목으로 (항목 3) →
                </Button>
              </div>
            </div>
          </div>
        )}
      </PageContainer>
    );
  }

  // 항목 8 전용 UI - 팔 뻗어 앞으로 내밀기
  if (isItem8) {
    const phaseLabels = {
      waiting: { text: '자세 준비', color: 'bg-slate-600' },
      reaching: { text: '측정 중', color: 'bg-blue-500' },
      complete: { text: '측정 완료!', color: 'bg-emerald-500' }
    };

    const currentPhase = phaseLabels[armReachState.testPhase] || phaseLabels.waiting;

    // 거리 기반 색상
    const getReachColor = (cm) => {
      if (cm >= 25) return 'text-emerald-400';
      if (cm >= 12.5) return 'text-yellow-400';
      if (cm >= 5) return 'text-orange-400';
      return 'text-red-400';
    };

    return (
      <PageContainer>
        <Header title="항목 8 / 14" onBack={() => navigateTo(PAGES.HOME)} />

        <main className="max-w-4xl mx-auto px-4 py-8">
          <div className="space-y-4">
            {/* 진행률 */}
            <ProgressBar progress={(8 / 14) * 100} color="blue" height="md" />

            {/* 단계 표시 */}
            {isAnalyzing && (
              <div className="flex items-center justify-between">
                <div className={`px-4 py-2 rounded-full ${currentPhase.color} text-white font-bold`}>
                  {currentPhase.text}
                </div>
                {armReachState.feetEverMoved && (
                  <div className="px-4 py-2 rounded-full bg-red-500 text-white font-bold animate-pulse">
                    발 움직임 감지!
                  </div>
                )}
              </div>
            )}

            {/* 항목 정보 */}
            <Card padding="md">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="text-white font-bold text-lg">8. 팔 뻗어 앞으로 내밀기</h3>
                  <p className="text-slate-400 text-sm">선 자세에서 팔을 90도로 뻗어 최대한 앞으로 내밀기</p>
                </div>
                <Badge variant="testType" value="BBS" size="md">AI 자동</Badge>
              </div>

              <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg text-sm">
                <p className="text-blue-400 mb-2"><strong>검사 순서:</strong></p>
                <ol className="text-slate-400 space-y-1 list-decimal list-inside">
                  <li className={armReachState.testPhase !== 'waiting' ? 'text-emerald-400' : ''}>
                    서서 팔을 앞으로 90도 뻗기 (1.5초 유지)
                  </li>
                  <li className={armReachState.testPhase === 'complete' ? 'text-emerald-400' : ''}>
                    최대한 앞으로 내밀기 (발은 고정)
                  </li>
                  <li className={armReachState.testPhase === 'complete' ? 'text-emerald-400' : ''}>
                    원위치로 돌아오면 자동 측정 완료
                  </li>
                </ol>
                <p className="text-purple-400 text-xs mt-2">* 카메라를 측면에 배치하면 가장 정확합니다</p>
              </div>
            </Card>

            {/* 항목별 영상 업로드 */}
            {inputMode === 'upload' && !isAnalyzing && (
              <DualVideoUpload
                sideFile={curVid.sideFile}
                sideUrl={curVid.sideUrl}
                onSideSelect={handleSideSelect}
                onSideRemove={handleSideRemove}
                frontFile={curVid.frontFile}
                frontUrl={curVid.frontUrl}
                onFrontSelect={handleFrontSelect}
                onFrontRemove={handleFrontRemove}
                accentColor="blue"
              />
            )}

            {/* 카메라 뷰 */}
            <div className="aspect-video bg-slate-800 rounded-2xl overflow-hidden relative">
              <video ref={videoRef} className="hidden" playsInline />
              <canvas ref={canvasRef} className="w-full h-full object-contain" />

              {/* 카메라 시작 전 */}
              {!isAnalyzing && !cameraLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-900/80">
                  <div className="text-center space-y-4">
                    <div className="w-24 h-24 mx-auto rounded-full bg-blue-500/20 flex items-center justify-center">
                      <svg className="w-12 h-12 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    </div>
                    <p className="text-slate-300">{inputMode === 'upload' && !videoUrl ? '위에서 영상을 업로드하세요' : '측면에서 전신이 보이도록 카메라를 배치해주세요'}</p>
                    <Button variant="bbs" size="lg" onClick={startItem} disabled={inputMode === 'upload' && !videoUrl}>
                      {inputMode === 'upload' && !videoUrl ? '영상을 먼저 업로드하세요' : '검사 시작'}
                    </Button>
                  </div>
                </div>
              )}

              {/* 영상 분석 중 표시 */}
              {videoAnalyzing && isAnalyzing && (
                <div className="absolute top-0 left-0 right-0 bg-blue-600/90 backdrop-blur-sm px-4 py-2 z-10">
                  <div className="flex items-center gap-3">
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span className="text-white font-medium text-sm">동영상 분석 중...</span>
                    <span className="text-blue-200 text-sm ml-auto">{videoProgress}%</span>
                  </div>
                  <div className="w-full bg-blue-800 rounded-full h-1.5 mt-1">
                    <div className="bg-white h-1.5 rounded-full transition-all" style={{ width: `${videoProgress}%` }} />
                  </div>
                </div>
              )}

              {/* 카메라 로딩 중 */}
              {cameraLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-900/80">
                  <div className="text-center space-y-4">
                    <div className="w-16 h-16 mx-auto border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
                    <p className="text-slate-300">카메라 초기화 중...</p>
                  </div>
                </div>
              )}

              {/* 분석 중 오버레이 */}
              {isAnalyzing && !cameraLoading && (
                <>
                  {/* 상단 좌측: 팔 상태 */}
                  <div className="absolute top-4 left-4 space-y-2">
                    <div className={`px-4 py-2 rounded-xl backdrop-blur-sm shadow-lg ${
                      armReachState.armRaised ? 'bg-emerald-500' : 'bg-slate-600'
                    }`}>
                      <p className="text-white font-bold text-lg">
                        {armReachState.armRaised ? '팔 90도 OK' : '팔 들기 대기'}
                      </p>
                    </div>
                    <div className="bg-slate-900/80 backdrop-blur-sm px-3 py-2 rounded-lg">
                      <p className="text-slate-400 text-xs">어깨 {armReachState.shoulderAngle}° / 팔꿈치 {armReachState.elbowAngle}°</p>
                      {armReachState.viewAngle && (
                        <p className={`text-xs mt-1 ${armReachState.viewAngle === 'side' ? 'text-emerald-400' : 'text-yellow-400'}`}>
                          {armReachState.viewAngle === 'side' ? '측면 촬영 (정확도 높음)' : '정면 촬영 (측면 권장)'}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* 상단 우측: 피드백 메시지 */}
                  <div className={`absolute top-4 right-4 px-4 py-3 rounded-xl backdrop-blur-sm shadow-lg max-w-[250px] ${
                    armReachState.feedback.type === 'success' ? 'bg-emerald-500' :
                    armReachState.feedback.type === 'error' ? 'bg-red-500' :
                    armReachState.feedback.type === 'warning' ? 'bg-yellow-500' :
                    'bg-blue-500'
                  }`}>
                    <p className="text-white font-bold text-lg">{armReachState.feedback.message}</p>
                  </div>

                  {/* 하단: 거리 측정 */}
                  {armReachState.testPhase === 'reaching' && (
                    <div className="absolute bottom-4 left-4 right-4">
                      <div className="bg-slate-900/90 backdrop-blur-sm p-4 rounded-xl">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-slate-400 text-sm">뻗은 거리</span>
                          <span className={`text-3xl font-bold font-mono ${getReachColor(armReachState.maxReachCm)}`}>
                            {armReachState.maxReachCm} cm
                          </span>
                        </div>
                        {/* 거리 게이지 바 */}
                        <div className="relative w-full bg-slate-700 rounded-full h-6 overflow-hidden">
                          <div
                            className={`h-6 rounded-full transition-all duration-200 ${
                              armReachState.maxReachCm >= 25 ? 'bg-emerald-500' :
                              armReachState.maxReachCm >= 12.5 ? 'bg-yellow-500' :
                              armReachState.maxReachCm >= 5 ? 'bg-orange-500' : 'bg-red-500'
                            }`}
                            style={{ width: `${Math.min(100, (armReachState.maxReachCm / 30) * 100)}%` }}
                          />
                          {/* 기준선 표시 */}
                          <div className="absolute top-0 bottom-0 left-[16.7%] w-px bg-white/30" title="5cm" />
                          <div className="absolute top-0 bottom-0 left-[41.7%] w-px bg-white/30" title="12.5cm" />
                          <div className="absolute top-0 bottom-0 left-[83.3%] w-px bg-white/50" title="25cm" />
                        </div>
                        <div className="flex justify-between text-xs text-slate-500 mt-1">
                          <span>0cm</span>
                          <span className="text-orange-400">5cm</span>
                          <span className="text-yellow-400">12.5cm</span>
                          <span className="text-emerald-400">25cm</span>
                          <span>30cm</span>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* 단계별 안내 카드 */}
            {isAnalyzing && !armReachState.showResultModal && (
              <Card padding="md" className={`border-2 ${
                armReachState.testPhase === 'waiting' ? 'border-slate-600' :
                armReachState.testPhase === 'reaching' ? 'border-blue-500' :
                'border-emerald-500'
              }`}>
                {armReachState.testPhase === 'waiting' && (
                  <div className="text-center py-4">
                    <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-slate-700 flex items-center justify-center">
                      <span className="text-4xl">💪</span>
                    </div>
                    <h4 className="text-white font-bold text-xl mb-2">팔을 앞으로 90도 뻗어주세요</h4>
                    <p className="text-slate-400">서서 팔을 어깨 높이까지 들어 앞으로 뻗으면 측정이 시작됩니다</p>
                    <div className="mt-4 flex items-center justify-center gap-2">
                      <div className="w-3 h-3 bg-blue-500 rounded-full animate-pulse" />
                      <span className="text-blue-400 text-sm">
                        {armReachState.isStanding ? (armReachState.armRaised ? '자세 확인 중...' : '팔을 앞으로 뻗어주세요') : '서 있는 자세를 취해주세요'}
                      </span>
                    </div>
                  </div>
                )}

                {armReachState.testPhase === 'reaching' && (
                  <div className="text-center py-4">
                    <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-blue-500/20 flex items-center justify-center">
                      <span className="text-4xl">📏</span>
                    </div>
                    <h4 className="text-blue-400 font-bold text-xl mb-2">최대한 앞으로 내밀기!</h4>
                    <p className="text-white text-lg mb-2">
                      최대 거리: <strong className={getReachColor(armReachState.maxReachCm)}>
                        {armReachState.maxReachCm}cm
                      </strong>
                    </p>
                    <p className="text-slate-400 text-sm">발은 제자리에 두고 최대한 뻗은 후 돌아오면 자동 완료됩니다</p>

                    {/* 수동 완료 버튼 */}
                    {armReachState.maxReachCm >= 1 && (
                      <div className="mt-4">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            markArmReachComplete();
                            const score = calculateArmReachScore(armReachState.maxReachCm, armReachState.feetEverMoved, false);
                            const report = generateArmReachReport(score, armReachState.maxReachCm, armReachState.feetEverMoved);
                            setArmReachState(prev => ({
                              ...prev,
                              testPhase: 'complete',
                              autoScore: score,
                              assessmentReport: report,
                              showResultModal: true
                            }));
                          }}
                        >
                          측정 완료 ({armReachState.maxReachCm}cm)
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </Card>
            )}

            {/* 이전 항목 / 건너뛰기 버튼 */}
            {!armReachState.showResultModal && (
              <div className="flex justify-between">
                <Button
                  variant="ghost"
                  className="flex-1"
                  onClick={() => {
                    if (timerRef.current) clearInterval(timerRef.current);
                    if (animationFrameRef.current) {
                      cancelAnimationFrame(animationFrameRef.current);
                      animationFrameRef.current = null;
                    }
                    stopCamera();
                    if (videoRef.current) {
                      videoRef.current.pause();
                      videoRef.current.srcObject = null;
                      videoRef.current.onplay = null;
                      videoRef.current.onended = null;
                    }
                    setIsAnalyzing(false);
                    setItemTimer(0);
                    setCurrentLandmarks(null);
                    setCurrentItem(currentItem - 1);
                  }}
                >
                  ← 이전 항목
                </Button>
                <Button
                  variant="ghost"
                  className="flex-1 text-yellow-400 border-yellow-500/30 hover:bg-yellow-500/10"
                  onClick={() => {
                    if (timerRef.current) clearInterval(timerRef.current);
                    if (animationFrameRef.current) {
                      cancelAnimationFrame(animationFrameRef.current);
                      animationFrameRef.current = null;
                    }
                    stopCamera();
                    if (videoRef.current) {
                      videoRef.current.pause();
                      videoRef.current.srcObject = null;
                      videoRef.current.onplay = null;
                      videoRef.current.onended = null;
                    }
                    setIsAnalyzing(false);
                    setItemTimer(0);
                    setCurrentLandmarks(null);
                    setCurrentItem(currentItem + 1);
                  }}
                >
                  건너뛰기 →
                </Button>
              </div>
            )}
          </div>
        </main>

        {/* 결과 모달 */}
        {armReachState.showResultModal && armReachState.assessmentReport && (
          <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-slate-900 rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto border border-slate-700 shadow-2xl">
              {/* 헤더 */}
              <div className={`p-6 text-center ${
                armReachState.assessmentReport.scoring.autoScore >= 3 ? 'bg-emerald-500/20' : 'bg-yellow-500/20'
              }`}>
                <div className={`w-20 h-20 mx-auto mb-4 rounded-full flex items-center justify-center ${
                  armReachState.assessmentReport.scoring.autoScore >= 3 ? 'bg-emerald-500' : 'bg-yellow-500'
                }`}>
                  <span className="text-4xl">
                    {armReachState.assessmentReport.scoring.autoScore >= 3 ? '✓' : '⚠️'}
                  </span>
                </div>
                <h2 className="text-white font-bold text-2xl mb-2">항목 8 검사 완료</h2>
                <p className="text-slate-400">팔 뻗어 앞으로 내밀기</p>
              </div>

              {/* 점수 */}
              <div className="p-6 border-b border-slate-700">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-slate-400 text-sm">AI 자동 채점</p>
                    <p className="text-5xl font-bold text-white">
                      {armReachState.assessmentReport.scoring.autoScore}
                      <span className="text-xl text-slate-500 ml-1">/ 4점</span>
                    </p>
                  </div>
                  <div className="w-24 h-24 relative">
                    <svg className="w-24 h-24 transform -rotate-90">
                      <circle cx="48" cy="48" r="40" stroke="#334155" strokeWidth="8" fill="none" />
                      <circle
                        cx="48" cy="48" r="40"
                        stroke={armReachState.assessmentReport.scoring.autoScore >= 3 ? '#10B981' : '#EAB308'}
                        strokeWidth="8"
                        fill="none"
                        strokeDasharray={`${(armReachState.assessmentReport.scoring.autoScore / 4) * 251} 251`}
                        strokeLinecap="round"
                      />
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="text-3xl font-bold text-white">{armReachState.assessmentReport.scoring.autoScore}</span>
                    </div>
                  </div>
                </div>
                <p className={`mt-3 text-lg font-medium ${
                  armReachState.assessmentReport.scoring.autoScore >= 3 ? 'text-emerald-400' : 'text-yellow-400'
                }`}>
                  {armReachState.assessmentReport.scoring.reason}
                </p>
              </div>

              {/* 분석 결과 */}
              <div className="p-6 space-y-4">
                <h3 className="text-white font-bold">AI 분석 결과</h3>

                <div className="grid grid-cols-2 gap-3">
                  <div className="p-3 bg-slate-800 rounded-xl">
                    <p className="text-slate-400 text-xs mb-1">최대 뻗은 거리</p>
                    <p className={`font-bold text-2xl ${getReachColor(parseFloat(armReachState.assessmentReport.measurement.maxReachCm))}`}>
                      {armReachState.assessmentReport.measurement.maxReachCm}cm
                    </p>
                  </div>
                  <div className="p-3 bg-slate-800 rounded-xl">
                    <p className="text-slate-400 text-xs mb-1">발 움직임</p>
                    <p className={`font-bold text-lg ${
                      armReachState.assessmentReport.measurement.feetMoved
                        ? 'text-red-400'
                        : 'text-emerald-400'
                    }`}>
                      {armReachState.assessmentReport.measurement.feetMoved ? '움직임 감지' : '고정 유지'}
                    </p>
                  </div>
                </div>

                {/* 점수 기준 안내 */}
                <div className="p-3 bg-slate-800 rounded-xl space-y-1">
                  <p className="text-slate-400 text-xs mb-2">점수 기준</p>
                  <p className={`text-xs ${armReachState.assessmentReport.scoring.autoScore === 4 ? 'text-emerald-400 font-bold' : 'text-slate-500'}`}>4점: 25cm 이상 자신있게</p>
                  <p className={`text-xs ${armReachState.assessmentReport.scoring.autoScore === 3 ? 'text-yellow-400 font-bold' : 'text-slate-500'}`}>3점: 12.5cm 이상 안전하게</p>
                  <p className={`text-xs ${armReachState.assessmentReport.scoring.autoScore === 2 ? 'text-orange-400 font-bold' : 'text-slate-500'}`}>2점: 5cm 이상 안전하게</p>
                  <p className={`text-xs ${armReachState.assessmentReport.scoring.autoScore === 1 ? 'text-red-400 font-bold' : 'text-slate-500'}`}>1점: 앞으로 뻗지만 감독 필요</p>
                  <p className={`text-xs ${armReachState.assessmentReport.scoring.autoScore === 0 ? 'text-red-500 font-bold' : 'text-slate-500'}`}>0점: 균형 상실 / 외부 지지 필요</p>
                </div>
              </div>

              {/* 버튼 */}
              <div className="p-6 bg-slate-800/50">
                <Button
                  variant="bbs"
                  size="lg"
                  fullWidth
                  onClick={() => handleScore(armReachState.assessmentReport.scoring.autoScore)}
                >
                  다음 항목으로 (항목 9) →
                </Button>
              </div>
            </div>
          </div>
        )}
      </PageContainer>
    );
  }

  // 항목 9 전용 UI - 바닥의 물건 집기
  if (isItem9) {
    const phaseLabels = {
      waiting: { text: '자세 준비', color: 'bg-slate-600' },
      bending: { text: '측정 중', color: 'bg-blue-500' },
      complete: { text: '측정 완료!', color: 'bg-emerald-500' }
    };

    const currentPhase = phaseLabels[pickUpState.testPhase] || phaseLabels.waiting;

    // 거리 기반 색상
    const getDistColor = (cm) => {
      if (cm <= 0) return 'text-emerald-400';
      if (cm <= 5) return 'text-yellow-400';
      if (cm <= 10) return 'text-orange-400';
      return 'text-red-400';
    };

    return (
      <PageContainer>
        <Header title="항목 9 / 14" onBack={() => navigateTo(PAGES.HOME)} />

        <main className="max-w-4xl mx-auto px-4 py-8">
          <div className="space-y-4">
            {/* 진행률 */}
            <ProgressBar progress={(9 / 14) * 100} color="blue" height="md" />

            {/* 단계 표시 */}
            {isAnalyzing && (
              <div className="flex items-center justify-between">
                <div className={`px-4 py-2 rounded-full ${currentPhase.color} text-white font-bold`}>
                  {currentPhase.text}
                </div>
                {pickUpState.feetEverMoved && (
                  <div className="px-4 py-2 rounded-full bg-red-500 text-white font-bold animate-pulse">
                    발 움직임 감지!
                  </div>
                )}
              </div>
            )}

            {/* 항목 정보 */}
            <Card padding="md">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="text-white font-bold text-lg">9. 바닥의 물건 집기</h3>
                  <p className="text-slate-400 text-sm">선 자세에서 허리를 굽혀 바닥의 물건을 집기</p>
                </div>
                <Badge variant="testType" value="BBS" size="md">AI 자동</Badge>
              </div>

              <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg text-sm">
                <p className="text-blue-400 mb-2"><strong>검사 순서:</strong></p>
                <ol className="text-slate-400 space-y-1 list-decimal list-inside">
                  <li className={pickUpState.testPhase !== 'waiting' ? 'text-emerald-400' : ''}>
                    바르게 서기 (1.5초 유지)
                  </li>
                  <li className={pickUpState.testPhase === 'complete' ? 'text-emerald-400' : ''}>
                    허리를 굽혀 바닥의 물건 집기
                  </li>
                  <li className={pickUpState.testPhase === 'complete' ? 'text-emerald-400' : ''}>
                    다시 일어서면 자동 측정 완료
                  </li>
                </ol>
                <p className="text-purple-400 text-xs mt-2">* 전신이 보이도록 카메라를 배치해주세요</p>
              </div>
            </Card>

            {/* 항목별 영상 업로드 */}
            {inputMode === 'upload' && !isAnalyzing && (
              <DualVideoUpload
                sideFile={curVid.sideFile}
                sideUrl={curVid.sideUrl}
                onSideSelect={handleSideSelect}
                onSideRemove={handleSideRemove}
                frontFile={curVid.frontFile}
                frontUrl={curVid.frontUrl}
                onFrontSelect={handleFrontSelect}
                onFrontRemove={handleFrontRemove}
                accentColor="blue"
              />
            )}

            {/* 카메라 뷰 */}
            <div className="aspect-video bg-slate-800 rounded-2xl overflow-hidden relative">
              <video ref={videoRef} className="hidden" playsInline />
              <canvas ref={canvasRef} className="w-full h-full object-contain" />

              {/* 카메라 시작 전 */}
              {!isAnalyzing && !cameraLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-900/80">
                  <div className="text-center space-y-4">
                    <div className="w-24 h-24 mx-auto rounded-full bg-blue-500/20 flex items-center justify-center">
                      <svg className="w-12 h-12 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    </div>
                    <p className="text-slate-300">{inputMode === 'upload' && !videoUrl ? '위에서 영상을 업로드하세요' : '전신이 보이도록 카메라를 배치해주세요'}</p>
                    <Button variant="bbs" size="lg" onClick={startItem} disabled={inputMode === 'upload' && !videoUrl}>
                      {inputMode === 'upload' && !videoUrl ? '영상을 먼저 업로드하세요' : '검사 시작'}
                    </Button>
                  </div>
                </div>
              )}

              {/* 영상 분석 중 표시 */}
              {videoAnalyzing && isAnalyzing && (
                <div className="absolute top-0 left-0 right-0 bg-blue-600/90 backdrop-blur-sm px-4 py-2 z-10">
                  <div className="flex items-center gap-3">
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span className="text-white font-medium text-sm">동영상 분석 중...</span>
                    <span className="text-blue-200 text-sm ml-auto">{videoProgress}%</span>
                  </div>
                  <div className="w-full bg-blue-800 rounded-full h-1.5 mt-1">
                    <div className="bg-white h-1.5 rounded-full transition-all" style={{ width: `${videoProgress}%` }} />
                  </div>
                </div>
              )}

              {/* 카메라 로딩 중 */}
              {cameraLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-900/80">
                  <div className="text-center space-y-4">
                    <div className="w-16 h-16 mx-auto border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
                    <p className="text-slate-300">카메라 초기화 중...</p>
                  </div>
                </div>
              )}

              {/* 분석 중 오버레이 */}
              {isAnalyzing && !cameraLoading && (
                <>
                  {/* 상단 좌측: 굽힘 상태 */}
                  <div className="absolute top-4 left-4 space-y-2">
                    <div className={`px-4 py-2 rounded-xl backdrop-blur-sm shadow-lg ${
                      pickUpState.isBending ? 'bg-yellow-500' : (pickUpState.isStanding ? 'bg-emerald-500' : 'bg-slate-600')
                    }`}>
                      <p className="text-white font-bold text-lg">
                        {pickUpState.isBending ? '허리 굽힘 중' : (pickUpState.isStanding ? '서 있음' : '자세 대기')}
                      </p>
                    </div>
                    <div className="bg-slate-900/80 backdrop-blur-sm px-3 py-2 rounded-lg">
                      <p className="text-slate-400 text-xs">굽힘 각도: {pickUpState.bendAngle}°</p>
                    </div>
                  </div>

                  {/* 상단 우측: 피드백 메시지 */}
                  <div className={`absolute top-4 right-4 px-4 py-3 rounded-xl backdrop-blur-sm shadow-lg max-w-[250px] ${
                    pickUpState.feedback.type === 'success' ? 'bg-emerald-500' :
                    pickUpState.feedback.type === 'error' ? 'bg-red-500' :
                    pickUpState.feedback.type === 'warning' ? 'bg-yellow-500' :
                    'bg-blue-500'
                  }`}>
                    <p className="text-white font-bold text-lg">{pickUpState.feedback.message}</p>
                  </div>

                  {/* 하단: 거리 측정 */}
                  {pickUpState.testPhase === 'bending' && (
                    <div className="absolute bottom-4 left-4 right-4">
                      <div className="bg-slate-900/90 backdrop-blur-sm p-4 rounded-xl">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-slate-400 text-sm">손목-발목 거리</span>
                          <span className={`text-3xl font-bold font-mono ${getDistColor(pickUpState.minWristToAnkleCm)}`}>
                            {pickUpState.minWristToAnkleCm <= 0 ? '바닥 도달!' : `${pickUpState.minWristToAnkleCm} cm`}
                          </span>
                        </div>
                        {/* 바닥 도달 표시 */}
                        <div className="flex items-center gap-2 mt-2">
                          <div className={`w-4 h-4 rounded-full ${pickUpState.reachedFloor ? 'bg-emerald-500' : 'bg-slate-600'}`} />
                          <span className={`text-sm ${pickUpState.reachedFloor ? 'text-emerald-400' : 'text-slate-500'}`}>
                            {pickUpState.reachedFloor ? '바닥 도달 성공' : '바닥 미도달'}
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* 단계별 안내 카드 */}
            {isAnalyzing && !pickUpState.showResultModal && (
              <Card padding="md" className={`border-2 ${
                pickUpState.testPhase === 'waiting' ? 'border-slate-600' :
                pickUpState.testPhase === 'bending' ? 'border-blue-500' :
                'border-emerald-500'
              }`}>
                {pickUpState.testPhase === 'waiting' && (
                  <div className="text-center py-4">
                    <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-slate-700 flex items-center justify-center">
                      <span className="text-4xl">🧍</span>
                    </div>
                    <h4 className="text-white font-bold text-xl mb-2">바르게 서 주세요</h4>
                    <p className="text-slate-400">서 있는 자세를 1.5초 유지하면 측정이 시작됩니다</p>
                    <div className="mt-4 flex items-center justify-center gap-2">
                      <div className="w-3 h-3 bg-blue-500 rounded-full animate-pulse" />
                      <span className="text-blue-400 text-sm">
                        {pickUpState.isStanding ? '자세 확인 중...' : '서 있는 자세를 취해주세요'}
                      </span>
                    </div>
                  </div>
                )}

                {pickUpState.testPhase === 'bending' && (
                  <div className="text-center py-4">
                    <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-blue-500/20 flex items-center justify-center">
                      <span className="text-4xl">🫳</span>
                    </div>
                    <h4 className="text-blue-400 font-bold text-xl mb-2">바닥의 물건을 집으세요!</h4>
                    <p className="text-white text-lg mb-2">
                      손목-발목 거리: <strong className={getDistColor(pickUpState.minWristToAnkleCm)}>
                        {pickUpState.minWristToAnkleCm <= 0 ? '바닥 도달!' : `${pickUpState.minWristToAnkleCm}cm`}
                      </strong>
                    </p>
                    <p className="text-slate-400 text-sm">물건을 집은 후 다시 일어서면 자동 완료됩니다</p>

                    {/* 수동 완료 버튼 */}
                    {(pickUpState.reachedFloor || pickUpState.minWristToAnkleCm < 50) && (
                      <div className="mt-4">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            markPickUpComplete();
                            const minDist = pickUpState.minWristToAnkleCm;
                            const reached = minDist <= 0;
                            const score = calculatePickUpScore(Math.max(0, minDist), reached, pickUpState.feetEverMoved, false);
                            const report = generatePickUpReport(score, Math.max(0, minDist), reached, pickUpState.feetEverMoved);
                            setPickUpState(prev => ({
                              ...prev,
                              testPhase: 'complete',
                              autoScore: score,
                              assessmentReport: report,
                              showResultModal: true
                            }));
                          }}
                        >
                          측정 완료
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </Card>
            )}

            {/* 이전 항목 / 건너뛰기 버튼 */}
            {!pickUpState.showResultModal && (
              <div className="flex justify-between">
                <Button
                  variant="ghost"
                  className="flex-1"
                  onClick={() => {
                    if (timerRef.current) clearInterval(timerRef.current);
                    if (animationFrameRef.current) {
                      cancelAnimationFrame(animationFrameRef.current);
                      animationFrameRef.current = null;
                    }
                    stopCamera();
                    if (videoRef.current) {
                      videoRef.current.pause();
                      videoRef.current.srcObject = null;
                      videoRef.current.onplay = null;
                      videoRef.current.onended = null;
                    }
                    setIsAnalyzing(false);
                    setItemTimer(0);
                    setCurrentLandmarks(null);
                    setCurrentItem(currentItem - 1);
                  }}
                >
                  ← 이전 항목
                </Button>
                <Button
                  variant="ghost"
                  className="flex-1 text-yellow-400 border-yellow-500/30 hover:bg-yellow-500/10"
                  onClick={() => {
                    if (timerRef.current) clearInterval(timerRef.current);
                    if (animationFrameRef.current) {
                      cancelAnimationFrame(animationFrameRef.current);
                      animationFrameRef.current = null;
                    }
                    stopCamera();
                    if (videoRef.current) {
                      videoRef.current.pause();
                      videoRef.current.srcObject = null;
                      videoRef.current.onplay = null;
                      videoRef.current.onended = null;
                    }
                    setIsAnalyzing(false);
                    setItemTimer(0);
                    setCurrentLandmarks(null);
                    setCurrentItem(currentItem + 1);
                  }}
                >
                  건너뛰기 →
                </Button>
              </div>
            )}
          </div>
        </main>

        {/* 결과 모달 */}
        {pickUpState.showResultModal && pickUpState.assessmentReport && (
          <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-slate-900 rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto border border-slate-700 shadow-2xl">
              {/* 헤더 */}
              <div className={`p-6 text-center ${
                pickUpState.assessmentReport.scoring.autoScore >= 3 ? 'bg-emerald-500/20' : 'bg-yellow-500/20'
              }`}>
                <div className={`w-20 h-20 mx-auto mb-4 rounded-full flex items-center justify-center ${
                  pickUpState.assessmentReport.scoring.autoScore >= 3 ? 'bg-emerald-500' : 'bg-yellow-500'
                }`}>
                  <span className="text-4xl">
                    {pickUpState.assessmentReport.scoring.autoScore >= 3 ? '✓' : '⚠️'}
                  </span>
                </div>
                <h2 className="text-white font-bold text-2xl mb-2">항목 9 검사 완료</h2>
                <p className="text-slate-400">바닥의 물건 집기</p>
              </div>

              {/* 점수 */}
              <div className="p-6 border-b border-slate-700">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-slate-400 text-sm">AI 자동 채점</p>
                    <p className="text-5xl font-bold text-white">
                      {pickUpState.assessmentReport.scoring.autoScore}
                      <span className="text-xl text-slate-500 ml-1">/ 4점</span>
                    </p>
                  </div>
                  <div className="w-24 h-24 relative">
                    <svg className="w-24 h-24 transform -rotate-90">
                      <circle cx="48" cy="48" r="40" stroke="#334155" strokeWidth="8" fill="none" />
                      <circle
                        cx="48" cy="48" r="40"
                        stroke={pickUpState.assessmentReport.scoring.autoScore >= 3 ? '#10B981' : '#EAB308'}
                        strokeWidth="8"
                        fill="none"
                        strokeDasharray={`${(pickUpState.assessmentReport.scoring.autoScore / 4) * 251} 251`}
                        strokeLinecap="round"
                      />
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="text-3xl font-bold text-white">{pickUpState.assessmentReport.scoring.autoScore}</span>
                    </div>
                  </div>
                </div>
                <p className={`mt-3 text-lg font-medium ${
                  pickUpState.assessmentReport.scoring.autoScore >= 3 ? 'text-emerald-400' : 'text-yellow-400'
                }`}>
                  {pickUpState.assessmentReport.scoring.reason}
                </p>
              </div>

              {/* 분석 결과 */}
              <div className="p-6 space-y-4">
                <h3 className="text-white font-bold">AI 분석 결과</h3>

                <div className="grid grid-cols-3 gap-3">
                  <div className="p-3 bg-slate-800 rounded-xl">
                    <p className="text-slate-400 text-xs mb-1">손목-발목 최소 거리</p>
                    <p className={`font-bold text-xl ${getDistColor(parseFloat(pickUpState.assessmentReport.measurement.minWristToAnkleCm))}`}>
                      {pickUpState.assessmentReport.measurement.minWristToAnkleCm}cm
                    </p>
                  </div>
                  <div className="p-3 bg-slate-800 rounded-xl">
                    <p className="text-slate-400 text-xs mb-1">바닥 도달</p>
                    <p className={`font-bold text-lg ${
                      pickUpState.assessmentReport.measurement.reachedFloor
                        ? 'text-emerald-400'
                        : 'text-red-400'
                    }`}>
                      {pickUpState.assessmentReport.measurement.reachedFloor ? '도달 성공' : '미도달'}
                    </p>
                  </div>
                  <div className="p-3 bg-slate-800 rounded-xl">
                    <p className="text-slate-400 text-xs mb-1">발 움직임</p>
                    <p className={`font-bold text-lg ${
                      pickUpState.assessmentReport.measurement.feetMoved
                        ? 'text-red-400'
                        : 'text-emerald-400'
                    }`}>
                      {pickUpState.assessmentReport.measurement.feetMoved ? '움직임 감지' : '고정 유지'}
                    </p>
                  </div>
                </div>

                {/* 점수 기준 안내 */}
                <div className="p-3 bg-slate-800 rounded-xl space-y-1">
                  <p className="text-slate-400 text-xs mb-2">점수 기준</p>
                  <p className={`text-xs ${pickUpState.assessmentReport.scoring.autoScore === 4 ? 'text-emerald-400 font-bold' : 'text-slate-500'}`}>4점: 안전하고 쉽게 물건을 집음</p>
                  <p className={`text-xs ${pickUpState.assessmentReport.scoring.autoScore === 3 ? 'text-yellow-400 font-bold' : 'text-slate-500'}`}>3점: 물건을 집었으나 감독 필요</p>
                  <p className={`text-xs ${pickUpState.assessmentReport.scoring.autoScore === 2 ? 'text-orange-400 font-bold' : 'text-slate-500'}`}>2점: 바닥 미도달, 5cm 이내</p>
                  <p className={`text-xs ${pickUpState.assessmentReport.scoring.autoScore === 1 ? 'text-red-400 font-bold' : 'text-slate-500'}`}>1점: 바닥 미도달, 감독 필요</p>
                  <p className={`text-xs ${pickUpState.assessmentReport.scoring.autoScore === 0 ? 'text-red-500 font-bold' : 'text-slate-500'}`}>0점: 균형 상실 / 외부 지지 필요</p>
                </div>
              </div>

              {/* 버튼 */}
              <div className="p-6 bg-slate-800/50">
                <Button
                  variant="bbs"
                  size="lg"
                  fullWidth
                  onClick={() => handleScore(pickUpState.assessmentReport.scoring.autoScore)}
                >
                  다음 항목으로 (항목 10) →
                </Button>
              </div>
            </div>
          </div>
        )}
      </PageContainer>
    );
  }

  // 항목 10 전용 UI - 뒤돌아보기
  if (isItem10) {
    const phaseLabels = {
      waiting: { text: '자세 준비', color: 'bg-slate-600' },
      measuring: { text: '측정 중', color: 'bg-blue-500' },
      complete: { text: '측정 완료!', color: 'bg-emerald-500' }
    };

    const currentPhase = phaseLabels[lookBehindState.testPhase] || phaseLabels.waiting;

    // 각도 기반 색상
    const getRotColor = (deg) => {
      if (deg >= 45) return 'text-emerald-400';
      if (deg >= 30) return 'text-yellow-400';
      if (deg >= 20) return 'text-orange-400';
      return 'text-red-400';
    };

    // 각도 → 게이지 퍼센트 (60°을 100%로)
    const rotToPercent = (deg) => Math.min(100, (deg / 60) * 100);

    // 각도 → 바 색상 클래스
    const getRotBarColor = (deg) => {
      if (deg >= 45) return 'bg-emerald-500';
      if (deg >= 30) return 'bg-yellow-500';
      if (deg >= 20) return 'bg-orange-500';
      return 'bg-red-500';
    };

    return (
      <PageContainer>
        <Header title="항목 10 / 14" onBack={() => navigateTo(PAGES.HOME)} />

        <main className="max-w-4xl mx-auto px-4 py-8">
          <div className="space-y-4">
            {/* 진행률 */}
            <ProgressBar progress={(10 / 14) * 100} color="blue" height="md" />

            {/* 단계 표시 */}
            {isAnalyzing && (
              <div className="flex items-center justify-between">
                <div className={`px-4 py-2 rounded-full ${currentPhase.color} text-white font-bold`}>
                  {currentPhase.text}
                </div>
                {lookBehindState.feetEverMoved && (
                  <div className="px-4 py-2 rounded-full bg-red-500 text-white font-bold animate-pulse">
                    발 움직임 감지!
                  </div>
                )}
              </div>
            )}

            {/* 항목 정보 */}
            <Card padding="md">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="text-white font-bold text-lg">10. 뒤돌아보기</h3>
                  <p className="text-slate-400 text-sm">왼쪽과 오른쪽으로 어깨 너머 뒤돌아보기</p>
                </div>
                <Badge variant="testType" value="BBS" size="md">AI 자동</Badge>
              </div>

              <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg text-sm">
                <p className="text-blue-400 mb-2"><strong>검사 순서:</strong></p>
                <ol className="text-slate-400 space-y-1 list-decimal list-inside">
                  <li className={lookBehindState.testPhase !== 'waiting' ? 'text-emerald-400' : ''}>
                    정면을 보고 바르게 서기 (1.5초 유지)
                  </li>
                  <li className={lookBehindState.leftMaxRotation >= 20 ? 'text-emerald-400' : ''}>
                    왼쪽 어깨 너머로 뒤돌아보기
                  </li>
                  <li className={lookBehindState.rightMaxRotation >= 20 ? 'text-emerald-400' : ''}>
                    오른쪽 어깨 너머로 뒤돌아보기
                  </li>
                  <li className={lookBehindState.testPhase === 'complete' ? 'text-emerald-400' : ''}>
                    정면으로 돌아오면 자동 완료
                  </li>
                </ol>
                <p className="text-purple-400 text-xs mt-2">* 정면에서 촬영해야 회전을 정확히 측정할 수 있습니다</p>
              </div>
            </Card>

            {/* 항목별 영상 업로드 */}
            {inputMode === 'upload' && !isAnalyzing && (
              <DualVideoUpload
                sideFile={curVid.sideFile}
                sideUrl={curVid.sideUrl}
                onSideSelect={handleSideSelect}
                onSideRemove={handleSideRemove}
                frontFile={curVid.frontFile}
                frontUrl={curVid.frontUrl}
                onFrontSelect={handleFrontSelect}
                onFrontRemove={handleFrontRemove}
                accentColor="blue"
              />
            )}

            {/* 카메라 뷰 */}
            <div className="aspect-video bg-slate-800 rounded-2xl overflow-hidden relative">
              <video ref={videoRef} className="hidden" playsInline />
              <canvas ref={canvasRef} className="w-full h-full object-contain" />

              {/* 카메라 시작 전 */}
              {!isAnalyzing && !cameraLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-900/80">
                  <div className="text-center space-y-4">
                    <div className="w-24 h-24 mx-auto rounded-full bg-blue-500/20 flex items-center justify-center">
                      <svg className="w-12 h-12 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    </div>
                    <p className="text-slate-300">{inputMode === 'upload' && !videoUrl ? '위에서 영상을 업로드하세요' : '정면에서 상체가 보이도록 카메라를 배치해주세요'}</p>
                    <Button variant="bbs" size="lg" onClick={startItem} disabled={inputMode === 'upload' && !videoUrl}>
                      {inputMode === 'upload' && !videoUrl ? '영상을 먼저 업로드하세요' : '검사 시작'}
                    </Button>
                  </div>
                </div>
              )}

              {/* 영상 분석 중 표시 */}
              {videoAnalyzing && isAnalyzing && (
                <div className="absolute top-0 left-0 right-0 bg-blue-600/90 backdrop-blur-sm px-4 py-2 z-10">
                  <div className="flex items-center gap-3">
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span className="text-white font-medium text-sm">동영상 분석 중...</span>
                    <span className="text-blue-200 text-sm ml-auto">{videoProgress}%</span>
                  </div>
                  <div className="w-full bg-blue-800 rounded-full h-1.5 mt-1">
                    <div className="bg-white h-1.5 rounded-full transition-all" style={{ width: `${videoProgress}%` }} />
                  </div>
                </div>
              )}

              {/* 카메라 로딩 중 */}
              {cameraLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-900/80">
                  <div className="text-center space-y-4">
                    <div className="w-16 h-16 mx-auto border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
                    <p className="text-slate-300">카메라 초기화 중...</p>
                  </div>
                </div>
              )}

              {/* 분석 중 오버레이 */}
              {isAnalyzing && !cameraLoading && (
                <>
                  {/* 상단 좌측: 회전 상태 */}
                  <div className="absolute top-4 left-4 space-y-2">
                    <div className={`px-4 py-2 rounded-xl backdrop-blur-sm shadow-lg ${
                      lookBehindState.turnDirection !== 'center' ? 'bg-yellow-500' :
                      (lookBehindState.isStanding ? 'bg-emerald-500' : 'bg-slate-600')
                    }`}>
                      <p className="text-white font-bold text-lg">
                        {lookBehindState.turnDirection === 'left' ? '← 왼쪽 회전' :
                         lookBehindState.turnDirection === 'right' ? '오른쪽 회전 →' :
                         (lookBehindState.isStanding ? '정면' : '자세 대기')}
                      </p>
                    </div>
                    <div className="bg-slate-900/80 backdrop-blur-sm px-3 py-2 rounded-lg">
                      <p className="text-slate-400 text-xs">현재 회전: {lookBehindState.rotationAngle}°</p>
                      {lookBehindState.viewAngle && (
                        <p className={`text-xs mt-1 ${lookBehindState.viewAngle === 'front' ? 'text-emerald-400' : 'text-yellow-400'}`}>
                          {lookBehindState.viewAngle === 'front' ? '정면 촬영 (정확도 높음)' : '측면 촬영 (정면 권장)'}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* 상단 우측: 피드백 메시지 */}
                  <div className={`absolute top-4 right-4 px-4 py-3 rounded-xl backdrop-blur-sm shadow-lg max-w-[250px] ${
                    lookBehindState.feedback.type === 'success' ? 'bg-emerald-500' :
                    lookBehindState.feedback.type === 'error' ? 'bg-red-500' :
                    lookBehindState.feedback.type === 'warning' ? 'bg-yellow-500' :
                    'bg-blue-500'
                  }`}>
                    <p className="text-white font-bold text-lg">{lookBehindState.feedback.message}</p>
                  </div>

                  {/* 하단: 양방향 회전 게이지 */}
                  {lookBehindState.testPhase === 'measuring' && (
                    <div className="absolute bottom-4 left-4 right-4">
                      <div className="bg-slate-900/90 backdrop-blur-sm p-4 rounded-xl">
                        <div className="grid grid-cols-2 gap-4">
                          {/* 왼쪽 회전 */}
                          <div>
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-slate-400 text-sm">← 왼쪽</span>
                              <span className={`text-lg font-bold font-mono ${getRotColor(lookBehindState.leftMaxRotation)}`}>
                                {lookBehindState.leftMaxRotation}°
                              </span>
                            </div>
                            <div className="w-full bg-slate-700 rounded-full h-4 overflow-hidden">
                              <div
                                className={`h-4 rounded-full transition-all duration-200 ${getRotBarColor(lookBehindState.leftMaxRotation)}`}
                                style={{ width: `${rotToPercent(lookBehindState.leftMaxRotation)}%` }}
                              />
                            </div>
                            <div className="flex items-center gap-1 mt-1">
                              <div className={`w-2 h-2 rounded-full ${lookBehindState.leftMaxRotation >= 20 ? 'bg-emerald-500' : 'bg-slate-600'}`} />
                              <span className={`text-xs ${lookBehindState.leftMaxRotation >= 20 ? 'text-emerald-400' : 'text-slate-500'}`}>
                                {lookBehindState.leftMaxRotation >= 45 ? '우수' : lookBehindState.leftMaxRotation >= 20 ? '감지됨' : '대기'}
                              </span>
                            </div>
                          </div>
                          {/* 오른쪽 회전 */}
                          <div>
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-slate-400 text-sm">오른쪽 →</span>
                              <span className={`text-lg font-bold font-mono ${getRotColor(lookBehindState.rightMaxRotation)}`}>
                                {lookBehindState.rightMaxRotation}°
                              </span>
                            </div>
                            <div className="w-full bg-slate-700 rounded-full h-4 overflow-hidden">
                              <div
                                className={`h-4 rounded-full transition-all duration-200 ${getRotBarColor(lookBehindState.rightMaxRotation)}`}
                                style={{ width: `${rotToPercent(lookBehindState.rightMaxRotation)}%` }}
                              />
                            </div>
                            <div className="flex items-center gap-1 mt-1">
                              <div className={`w-2 h-2 rounded-full ${lookBehindState.rightMaxRotation >= 20 ? 'bg-emerald-500' : 'bg-slate-600'}`} />
                              <span className={`text-xs ${lookBehindState.rightMaxRotation >= 20 ? 'text-emerald-400' : 'text-slate-500'}`}>
                                {lookBehindState.rightMaxRotation >= 45 ? '우수' : lookBehindState.rightMaxRotation >= 20 ? '감지됨' : '대기'}
                              </span>
                            </div>
                          </div>
                        </div>
                        {/* 기준선 안내 */}
                        <div className="flex justify-between text-xs text-slate-500 mt-2 px-1">
                          <span>0°</span>
                          <span className="text-orange-400">20°</span>
                          <span className="text-yellow-400">30°</span>
                          <span className="text-emerald-400">45°+</span>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* 단계별 안내 카드 */}
            {isAnalyzing && !lookBehindState.showResultModal && (
              <Card padding="md" className={`border-2 ${
                lookBehindState.testPhase === 'waiting' ? 'border-slate-600' :
                lookBehindState.testPhase === 'measuring' ? 'border-blue-500' :
                'border-emerald-500'
              }`}>
                {lookBehindState.testPhase === 'waiting' && (
                  <div className="text-center py-4">
                    <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-slate-700 flex items-center justify-center">
                      <span className="text-4xl">🧍</span>
                    </div>
                    <h4 className="text-white font-bold text-xl mb-2">정면을 보고 서 주세요</h4>
                    <p className="text-slate-400">서 있는 자세를 1.5초 유지하면 측정이 시작됩니다</p>
                    <div className="mt-4 flex items-center justify-center gap-2">
                      <div className="w-3 h-3 bg-blue-500 rounded-full animate-pulse" />
                      <span className="text-blue-400 text-sm">
                        {lookBehindState.isStanding ? '자세 확인 중...' : '서 있는 자세를 취해주세요'}
                      </span>
                    </div>
                  </div>
                )}

                {lookBehindState.testPhase === 'measuring' && (
                  <div className="text-center py-4">
                    <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-blue-500/20 flex items-center justify-center">
                      <span className="text-4xl">🔄</span>
                    </div>
                    <h4 className="text-blue-400 font-bold text-xl mb-2">어깨 너머로 뒤를 돌아보세요</h4>
                    <p className="text-slate-400 text-sm mb-3">왼쪽과 오른쪽 모두 돌아본 후 정면으로 돌아오면 자동 완료됩니다</p>

                    {/* 양방향 진행 상태 */}
                    <div className="flex justify-center gap-6 mb-3">
                      <div className="text-center">
                        <p className={`text-2xl font-bold ${getRotColor(lookBehindState.leftMaxRotation)}`}>
                          {lookBehindState.leftMaxRotation}°
                        </p>
                        <p className="text-slate-500 text-xs">← 왼쪽</p>
                      </div>
                      <div className="w-px bg-slate-600" />
                      <div className="text-center">
                        <p className={`text-2xl font-bold ${getRotColor(lookBehindState.rightMaxRotation)}`}>
                          {lookBehindState.rightMaxRotation}°
                        </p>
                        <p className="text-slate-500 text-xs">오른쪽 →</p>
                      </div>
                    </div>

                    {/* 수동 완료 버튼 */}
                    {(lookBehindState.leftMaxRotation >= 15 || lookBehindState.rightMaxRotation >= 15) && (
                      <div className="mt-4">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            markLookBehindComplete();
                            const score = calculateLookBehindScore(
                              lookBehindState.leftMaxRotation, lookBehindState.rightMaxRotation,
                              lookBehindState.leftWeightShift, lookBehindState.rightWeightShift,
                              lookBehindState.feetEverMoved, false
                            );
                            const report = generateLookBehindReport(
                              score,
                              lookBehindState.leftMaxRotation, lookBehindState.rightMaxRotation,
                              lookBehindState.leftWeightShift, lookBehindState.rightWeightShift,
                              lookBehindState.feetEverMoved
                            );
                            setLookBehindState(prev => ({
                              ...prev,
                              testPhase: 'complete',
                              autoScore: score,
                              assessmentReport: report,
                              showResultModal: true
                            }));
                          }}
                        >
                          측정 완료
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </Card>
            )}

            {/* 이전 항목 / 건너뛰기 버튼 */}
            {!lookBehindState.showResultModal && (
              <div className="flex justify-between">
                <Button
                  variant="ghost"
                  className="flex-1"
                  onClick={() => {
                    if (timerRef.current) clearInterval(timerRef.current);
                    if (animationFrameRef.current) {
                      cancelAnimationFrame(animationFrameRef.current);
                      animationFrameRef.current = null;
                    }
                    stopCamera();
                    if (videoRef.current) {
                      videoRef.current.pause();
                      videoRef.current.srcObject = null;
                      videoRef.current.onplay = null;
                      videoRef.current.onended = null;
                    }
                    setIsAnalyzing(false);
                    setItemTimer(0);
                    setCurrentLandmarks(null);
                    setCurrentItem(currentItem - 1);
                  }}
                >
                  ← 이전 항목
                </Button>
                <Button
                  variant="ghost"
                  className="flex-1 text-yellow-400 border-yellow-500/30 hover:bg-yellow-500/10"
                  onClick={() => {
                    if (timerRef.current) clearInterval(timerRef.current);
                    if (animationFrameRef.current) {
                      cancelAnimationFrame(animationFrameRef.current);
                      animationFrameRef.current = null;
                    }
                    stopCamera();
                    if (videoRef.current) {
                      videoRef.current.pause();
                      videoRef.current.srcObject = null;
                      videoRef.current.onplay = null;
                      videoRef.current.onended = null;
                    }
                    setIsAnalyzing(false);
                    setItemTimer(0);
                    setCurrentLandmarks(null);
                    setCurrentItem(currentItem + 1);
                  }}
                >
                  건너뛰기 →
                </Button>
              </div>
            )}
          </div>
        </main>

        {/* 결과 모달 */}
        {lookBehindState.showResultModal && lookBehindState.assessmentReport && (
          <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-slate-900 rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto border border-slate-700 shadow-2xl">
              {/* 헤더 */}
              <div className={`p-6 text-center ${
                lookBehindState.assessmentReport.scoring.autoScore >= 3 ? 'bg-emerald-500/20' : 'bg-yellow-500/20'
              }`}>
                <div className={`w-20 h-20 mx-auto mb-4 rounded-full flex items-center justify-center ${
                  lookBehindState.assessmentReport.scoring.autoScore >= 3 ? 'bg-emerald-500' : 'bg-yellow-500'
                }`}>
                  <span className="text-4xl">
                    {lookBehindState.assessmentReport.scoring.autoScore >= 3 ? '✓' : '⚠️'}
                  </span>
                </div>
                <h2 className="text-white font-bold text-2xl mb-2">항목 10 검사 완료</h2>
                <p className="text-slate-400">뒤돌아보기</p>
              </div>

              {/* 점수 */}
              <div className="p-6 border-b border-slate-700">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-slate-400 text-sm">AI 자동 채점</p>
                    <p className="text-5xl font-bold text-white">
                      {lookBehindState.assessmentReport.scoring.autoScore}
                      <span className="text-xl text-slate-500 ml-1">/ 4점</span>
                    </p>
                  </div>
                  <div className="w-24 h-24 relative">
                    <svg className="w-24 h-24 transform -rotate-90">
                      <circle cx="48" cy="48" r="40" stroke="#334155" strokeWidth="8" fill="none" />
                      <circle
                        cx="48" cy="48" r="40"
                        stroke={lookBehindState.assessmentReport.scoring.autoScore >= 3 ? '#10B981' : '#EAB308'}
                        strokeWidth="8"
                        fill="none"
                        strokeDasharray={`${(lookBehindState.assessmentReport.scoring.autoScore / 4) * 251} 251`}
                        strokeLinecap="round"
                      />
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="text-3xl font-bold text-white">{lookBehindState.assessmentReport.scoring.autoScore}</span>
                    </div>
                  </div>
                </div>
                <p className={`mt-3 text-lg font-medium ${
                  lookBehindState.assessmentReport.scoring.autoScore >= 3 ? 'text-emerald-400' : 'text-yellow-400'
                }`}>
                  {lookBehindState.assessmentReport.scoring.reason}
                </p>
              </div>

              {/* 분석 결과 */}
              <div className="p-6 space-y-4">
                <h3 className="text-white font-bold">AI 분석 결과</h3>

                <div className="grid grid-cols-3 gap-3">
                  <div className="p-3 bg-slate-800 rounded-xl">
                    <p className="text-slate-400 text-xs mb-1">← 왼쪽 회전</p>
                    <p className={`font-bold text-xl ${getRotColor(lookBehindState.assessmentReport.measurement.leftRotation)}`}>
                      {lookBehindState.assessmentReport.measurement.leftRotation}°
                    </p>
                  </div>
                  <div className="p-3 bg-slate-800 rounded-xl">
                    <p className="text-slate-400 text-xs mb-1">오른쪽 회전 →</p>
                    <p className={`font-bold text-xl ${getRotColor(lookBehindState.assessmentReport.measurement.rightRotation)}`}>
                      {lookBehindState.assessmentReport.measurement.rightRotation}°
                    </p>
                  </div>
                  <div className="p-3 bg-slate-800 rounded-xl">
                    <p className="text-slate-400 text-xs mb-1">발 움직임</p>
                    <p className={`font-bold text-lg ${
                      lookBehindState.assessmentReport.measurement.feetMoved
                        ? 'text-red-400'
                        : 'text-emerald-400'
                    }`}>
                      {lookBehindState.assessmentReport.measurement.feetMoved ? '움직임 감지' : '고정 유지'}
                    </p>
                  </div>
                </div>

                {/* 점수 기준 안내 */}
                <div className="p-3 bg-slate-800 rounded-xl space-y-1">
                  <p className="text-slate-400 text-xs mb-2">점수 기준</p>
                  <p className={`text-xs ${lookBehindState.assessmentReport.scoring.autoScore === 4 ? 'text-emerald-400 font-bold' : 'text-slate-500'}`}>4점: 양쪽 뒤돌아보기 우수 + 체중 이동 좋음</p>
                  <p className={`text-xs ${lookBehindState.assessmentReport.scoring.autoScore === 3 ? 'text-yellow-400 font-bold' : 'text-slate-500'}`}>3점: 한쪽 우수, 다른 쪽 보통</p>
                  <p className={`text-xs ${lookBehindState.assessmentReport.scoring.autoScore === 2 ? 'text-orange-400 font-bold' : 'text-slate-500'}`}>2점: 옆으로만 돌아볼 수 있음, 균형 유지</p>
                  <p className={`text-xs ${lookBehindState.assessmentReport.scoring.autoScore === 1 ? 'text-red-400 font-bold' : 'text-slate-500'}`}>1점: 회전 범위 부족, 감독 필요</p>
                  <p className={`text-xs ${lookBehindState.assessmentReport.scoring.autoScore === 0 ? 'text-red-500 font-bold' : 'text-slate-500'}`}>0점: 균형 상실 / 도움 필요</p>
                </div>
              </div>

              {/* 버튼 */}
              <div className="p-6 bg-slate-800/50">
                <Button
                  variant="bbs"
                  size="lg"
                  fullWidth
                  onClick={() => handleScore(lookBehindState.assessmentReport.scoring.autoScore)}
                >
                  다음 항목으로 (항목 11) →
                </Button>
              </div>
            </div>
          </div>
        )}
      </PageContainer>
    );
  }

  // 항목 11 전용 UI - 360도 회전
  if (isItem11) {
    const flowLabels = {
      waiting: { text: '서 있는 자세 대기', color: 'bg-slate-600' },
      measuring_first: { text: '1차 회전 측정 중', color: 'bg-blue-500' },
      pausing: { text: '잠시 대기', color: 'bg-yellow-500' },
      measuring_second: { text: '2차 회전 측정 중', color: 'bg-indigo-500' },
      complete: { text: '검사 완료!', color: 'bg-emerald-500' }
    };

    const phaseLabels = {
      facing_front: { text: '정면', color: 'bg-emerald-500' },
      turning_away: { text: '회전중', color: 'bg-yellow-500' },
      pose_lost: { text: '뒷면 감지', color: 'bg-red-500' },
      returning: { text: '복귀중', color: 'bg-blue-500' },
      turn_complete: { text: '완료', color: 'bg-emerald-500' }
    };

    const currentFlow = flowLabels[turn360State.testFlow] || flowLabels.waiting;
    const currentPhaseLabel = phaseLabels[turn360State.phase] || phaseLabels.facing_front;

    return (
      <PageContainer>
        <Header title="항목 11 / 14" onBack={() => navigateTo(PAGES.HOME)} />

        <main className="max-w-4xl mx-auto px-4 py-8">
          <div className="space-y-4">
            <ProgressBar progress={(11 / 14) * 100} color="blue" height="md" />

            {isAnalyzing && (
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className={`px-4 py-2 rounded-full ${currentFlow.color} text-white font-bold`}>
                  {currentFlow.text}
                </div>
                {(turn360State.testFlow === 'measuring_first' || turn360State.testFlow === 'measuring_second') && (
                  <div className={`px-3 py-1.5 rounded-full ${currentPhaseLabel.color} text-white font-medium text-sm`}>
                    {currentPhaseLabel.text}
                  </div>
                )}
              </div>
            )}

            <Card padding="md">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="text-white font-bold text-lg">11. 360도 회전</h3>
                  <p className="text-slate-400 text-sm">한 방향으로 360도 회전 후 반대 방향으로 360도 회전</p>
                </div>
                <Badge variant="testType" value="BBS" size="md">AI 자동</Badge>
              </div>

              <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg text-sm">
                <p className="text-blue-400 mb-2"><strong>검사 순서:</strong></p>
                <ol className="text-slate-400 space-y-1 list-decimal list-inside">
                  <li className={turn360State.testFlow !== 'waiting' ? 'text-emerald-400' : ''}>
                    정면을 보고 서기 → AI 자세 확인
                  </li>
                  <li className={turn360State.testFlow === 'pausing' || turn360State.testFlow === 'measuring_second' || turn360State.testFlow === 'complete' ? 'text-emerald-400' : ''}>
                    한 방향으로 360도 회전 (4초 이내)
                  </li>
                  <li className={turn360State.testFlow === 'measuring_second' || turn360State.testFlow === 'complete' ? 'text-emerald-400' : ''}>
                    반대 방향으로 360도 회전
                  </li>
                  <li className={turn360State.testFlow === 'complete' ? 'text-emerald-400' : ''}>
                    자동 채점
                  </li>
                </ol>
              </div>
            </Card>

            {/* 항목별 영상 업로드 */}
            {inputMode === 'upload' && !isAnalyzing && (
              <DualVideoUpload
                sideFile={curVid.sideFile}
                sideUrl={curVid.sideUrl}
                onSideSelect={handleSideSelect}
                onSideRemove={handleSideRemove}
                frontFile={curVid.frontFile}
                frontUrl={curVid.frontUrl}
                onFrontSelect={handleFrontSelect}
                onFrontRemove={handleFrontRemove}
                accentColor="blue"
              />
            )}

            {/* 카메라 뷰 */}
            <div className="aspect-video bg-slate-800 rounded-2xl overflow-hidden relative">
              <video ref={videoRef} className="hidden" playsInline />
              <canvas ref={canvasRef} className="w-full h-full object-contain" />

              {!isAnalyzing && !cameraLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-900/80">
                  <div className="text-center space-y-4">
                    <div className="w-24 h-24 mx-auto rounded-full bg-blue-500/20 flex items-center justify-center">
                      <svg className="w-12 h-12 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    </div>
                    <p className="text-slate-300">{inputMode === 'upload' && !videoUrl ? '위에서 영상을 업로드하세요' : '전신이 보이도록 카메라를 배치해주세요'}</p>
                    <Button variant="bbs" size="lg" onClick={startItem} disabled={inputMode === 'upload' && !videoUrl}>
                      {inputMode === 'upload' && !videoUrl ? '영상을 먼저 업로드하세요' : '검사 시작'}
                    </Button>
                  </div>
                </div>
              )}

              {cameraLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-900/80">
                  <div className="text-center space-y-4">
                    <div className="w-16 h-16 mx-auto border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
                    <p className="text-slate-300">카메라 초기화 중...</p>
                  </div>
                </div>
              )}

              {isAnalyzing && !cameraLoading && (
                <>
                  {/* 상단 좌측: 포즈 상태 */}
                  <div className="absolute top-4 left-4 space-y-2">
                    <div className={`px-4 py-2 rounded-xl backdrop-blur-sm shadow-lg ${
                      turn360State.poseLost ? 'bg-red-500' : 'bg-emerald-500'
                    }`}>
                      <p className="text-white font-bold text-lg">
                        {turn360State.poseLost ? '뒷면 감지 중' : '포즈 감지 중'}
                      </p>
                    </div>

                    {/* 경과 시간 */}
                    {(turn360State.testFlow === 'measuring_first' || turn360State.testFlow === 'measuring_second') && (
                      <div className="px-3 py-2 rounded-lg bg-slate-900/80 backdrop-blur-sm">
                        <p className="text-white font-mono text-lg">{turn360State.elapsedSec}초</p>
                      </div>
                    )}
                  </div>

                  {/* 상단 우측: 피드백 */}
                  <div className={`absolute top-4 right-4 px-4 py-3 rounded-xl backdrop-blur-sm shadow-lg max-w-[250px] ${
                    turn360State.feedback.type === 'success' ? 'bg-emerald-500' :
                    turn360State.feedback.type === 'warning' ? 'bg-yellow-500' :
                    turn360State.feedback.type === 'error' ? 'bg-red-500' :
                    'bg-blue-500'
                  }`}>
                    <p className="text-white font-bold text-lg">{turn360State.feedback.message}</p>
                  </div>

                  {/* 하단: 진행률 표시 */}
                  <div className="absolute bottom-4 left-4 right-4">
                    <div className="bg-slate-900/90 backdrop-blur-sm p-4 rounded-xl">
                      <div className="flex justify-between text-sm mb-2">
                        <span className="text-slate-400">회전 진행</span>
                        <span className="text-white font-bold">{turn360State.progress}%</span>
                      </div>
                      <div className="w-full bg-slate-700 rounded-full h-3">
                        <div
                          className="bg-gradient-to-r from-blue-500 to-indigo-500 h-3 rounded-full transition-all duration-500"
                          style={{ width: `${turn360State.progress}%` }}
                        />
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* 1차/2차 결과 패널 */}
            {isAnalyzing && !turn360State.showResultModal && (turn360State.firstTurnResult || turn360State.testFlow === 'measuring_first' || turn360State.testFlow === 'measuring_second') && (
              <Card padding="md">
                <div className="grid grid-cols-2 gap-4">
                  {/* 1차 회전 */}
                  <div className={`p-3 rounded-xl ${turn360State.firstTurnResult ? 'bg-emerald-500/10 border border-emerald-500/20' : 'bg-slate-800'}`}>
                    <p className="text-slate-400 text-xs mb-1">1차 회전</p>
                    {turn360State.firstTurnResult ? (
                      <>
                        <p className="text-white font-bold">{turn360State.firstTurnResult.direction === 'left' ? '왼쪽' : turn360State.firstTurnResult.direction === 'right' ? '오른쪽' : '방향 미판별'}</p>
                        <p className="text-emerald-400 text-sm">{turn360State.firstTurnResult.elapsedSec}초</p>
                      </>
                    ) : (
                      <p className="text-blue-400 text-sm animate-pulse">측정 중...</p>
                    )}
                  </div>
                  {/* 2차 회전 */}
                  <div className={`p-3 rounded-xl ${turn360State.secondTurnResult ? 'bg-emerald-500/10 border border-emerald-500/20' : 'bg-slate-800'}`}>
                    <p className="text-slate-400 text-xs mb-1">2차 회전</p>
                    {turn360State.secondTurnResult ? (
                      <>
                        <p className="text-white font-bold">{turn360State.secondTurnResult.direction === 'left' ? '왼쪽' : turn360State.secondTurnResult.direction === 'right' ? '오른쪽' : '방향 미판별'}</p>
                        <p className="text-emerald-400 text-sm">{turn360State.secondTurnResult.elapsedSec}초</p>
                      </>
                    ) : (
                      <p className="text-slate-500 text-sm">{turn360State.testFlow === 'measuring_second' ? '측정 중...' : '대기'}</p>
                    )}
                  </div>
                </div>
              </Card>
            )}

            {/* 수동 완료 버튼 */}
            {isAnalyzing && !turn360State.showResultModal && turn360State.testFlow !== 'complete' && (
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  className="text-slate-400"
                  onClick={() => {
                    // 현재까지 결과로 수동 완료
                    const first = turn360State.firstTurnResult || harvestCurrentTurnResult();
                    const second = turn360State.secondTurnResult;
                    const totalFeetMoved = first?.feetMoved || second?.feetMoved || false;
                    const score = calculateTurn360Score(first, second, totalFeetMoved);
                    const report = generateTurn360Report(score, first, second, totalFeetMoved);
                    markTurn360Complete();
                    setTurn360State(prev => ({
                      ...prev,
                      testFlow: 'complete',
                      firstTurnResult: first,
                      secondTurnResult: second,
                      autoScore: score,
                      assessmentReport: report,
                      showResultModal: true,
                      feedback: { message: '수동 완료', type: 'info' }
                    }));
                  }}
                >
                  수동 완료
                </Button>
              </div>
            )}

            {/* 이전/건너뛰기 */}
            {!turn360State.showResultModal && (
              <div className="flex justify-between">
                <Button
                  variant="ghost"
                  className="flex-1"
                  onClick={() => {
                    if (timerRef.current) clearInterval(timerRef.current);
                    if (animationFrameRef.current) {
                      cancelAnimationFrame(animationFrameRef.current);
                      animationFrameRef.current = null;
                    }
                    stopCamera();
                    if (videoRef.current) {
                      videoRef.current.pause();
                      videoRef.current.srcObject = null;
                      videoRef.current.onplay = null;
                      videoRef.current.onended = null;
                    }
                    setIsAnalyzing(false);
                    setItemTimer(0);
                    setCurrentLandmarks(null);
                    setCurrentItem(currentItem - 1);
                  }}
                >
                  ← 이전 항목
                </Button>
                <Button
                  variant="ghost"
                  className="flex-1 text-yellow-400 border-yellow-500/30 hover:bg-yellow-500/10"
                  onClick={() => {
                    if (timerRef.current) clearInterval(timerRef.current);
                    if (animationFrameRef.current) {
                      cancelAnimationFrame(animationFrameRef.current);
                      animationFrameRef.current = null;
                    }
                    stopCamera();
                    if (videoRef.current) {
                      videoRef.current.pause();
                      videoRef.current.srcObject = null;
                      videoRef.current.onplay = null;
                      videoRef.current.onended = null;
                    }
                    setIsAnalyzing(false);
                    setItemTimer(0);
                    setCurrentLandmarks(null);
                    setCurrentItem(currentItem + 1);
                  }}
                >
                  건너뛰기 →
                </Button>
              </div>
            )}
          </div>
        </main>

        {/* 결과 모달 */}
        {turn360State.showResultModal && turn360State.assessmentReport && (
          <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-slate-900 rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto border border-slate-700 shadow-2xl">
              <div className="p-6 text-center bg-emerald-500/20">
                <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-emerald-500 flex items-center justify-center">
                  <span className="text-4xl">✓</span>
                </div>
                <h2 className="text-white font-bold text-2xl mb-2">항목 11 검사 완료</h2>
                <p className="text-slate-400">360도 회전</p>
              </div>

              <div className="p-6 border-b border-slate-700">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-slate-400 text-sm">AI 자동 채점</p>
                    <p className="text-5xl font-bold text-white">
                      {turn360State.assessmentReport.scoring.autoScore}
                      <span className="text-xl text-slate-500 ml-1">/ 4점</span>
                    </p>
                  </div>
                  <div className="w-24 h-24 relative">
                    <svg className="w-24 h-24 transform -rotate-90">
                      <circle cx="48" cy="48" r="40" stroke="#334155" strokeWidth="8" fill="none" />
                      <circle
                        cx="48" cy="48" r="40"
                        stroke="#10B981"
                        strokeWidth="8"
                        fill="none"
                        strokeDasharray={`${(turn360State.assessmentReport.scoring.autoScore / 4) * 251} 251`}
                        strokeLinecap="round"
                      />
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="text-3xl font-bold text-white">{turn360State.assessmentReport.scoring.autoScore}</span>
                    </div>
                  </div>
                </div>
                <p className="mt-3 text-lg font-medium text-emerald-400">
                  {turn360State.assessmentReport.scoring.reason}
                </p>
              </div>

              <div className="p-6 space-y-4">
                <h3 className="text-white font-bold">AI 분석 결과</h3>

                <div className="grid grid-cols-2 gap-3">
                  <div className="p-3 bg-slate-800 rounded-xl">
                    <p className="text-slate-400 text-xs mb-1">1차 회전</p>
                    {turn360State.firstTurnResult ? (
                      <>
                        <p className="text-white font-bold text-lg">
                          {turn360State.firstTurnResult.direction === 'left' ? '왼쪽' : turn360State.firstTurnResult.direction === 'right' ? '오른쪽' : '-'}
                        </p>
                        <p className={`text-sm ${turn360State.firstTurnResult.elapsedSec <= 4 ? 'text-emerald-400' : 'text-yellow-400'}`}>
                          {turn360State.firstTurnResult.elapsedSec}초
                        </p>
                      </>
                    ) : (
                      <p className="text-slate-500">미완료</p>
                    )}
                  </div>
                  <div className="p-3 bg-slate-800 rounded-xl">
                    <p className="text-slate-400 text-xs mb-1">2차 회전</p>
                    {turn360State.secondTurnResult ? (
                      <>
                        <p className="text-white font-bold text-lg">
                          {turn360State.secondTurnResult.direction === 'left' ? '왼쪽' : turn360State.secondTurnResult.direction === 'right' ? '오른쪽' : '-'}
                        </p>
                        <p className={`text-sm ${turn360State.secondTurnResult.elapsedSec <= 4 ? 'text-emerald-400' : 'text-yellow-400'}`}>
                          {turn360State.secondTurnResult.elapsedSec}초
                        </p>
                      </>
                    ) : (
                      <p className="text-slate-500">미완료</p>
                    )}
                  </div>
                </div>

                <div className="p-3 bg-slate-800 rounded-xl">
                  <div className="flex justify-between items-center">
                    <span className="text-slate-400">발 움직임</span>
                    <span className={`px-3 py-1 rounded-full font-bold ${
                      turn360State.assessmentReport.measurement.feetMoved
                        ? 'bg-red-500/20 text-red-400'
                        : 'bg-emerald-500/20 text-emerald-400'
                    }`}>
                      {turn360State.assessmentReport.measurement.feetMoved ? '감지됨' : '없음'}
                    </span>
                  </div>
                </div>

                <div className="p-3 bg-slate-800/50 rounded-xl">
                  <p className="text-slate-500 text-xs font-medium mb-2">채점 기준</p>
                  <div className="space-y-1 text-xs text-slate-400">
                    <p>4점: 양방향 4초 이내, 안전</p>
                    <p>3점: 한 방향 4초 이내</p>
                    <p>2점: 양방향 완료, 느림</p>
                    <p>1점: 한 방향만 가능</p>
                    <p>0점: 360도 미완료</p>
                  </div>
                </div>
              </div>

              <div className="p-6 bg-slate-800/50">
                <Button
                  variant="bbs"
                  size="lg"
                  fullWidth
                  onClick={() => handleScore(turn360State.assessmentReport.scoring.autoScore)}
                >
                  다음 항목으로 (항목 12) →
                </Button>
              </div>
            </div>
          </div>
        )}
      </PageContainer>
    );
  }

  // 항목 12 전용 UI
  if (isItem12) {
    const phaseLabels = {
      waiting: { text: '서 있는 자세 대기', color: 'bg-slate-600' },
      measuring: { text: '측정 중', color: 'bg-pink-500' },
      complete: { text: '검사 완료!', color: 'bg-emerald-500' }
    };
    const currentPhaseLabel = phaseLabels[stepAlternatingState.testPhase] || phaseLabels.waiting;

    return (
      <PageContainer>
        <Header title="항목 12 / 14" onBack={() => navigateTo(PAGES.HOME)} />

        <main className="max-w-4xl mx-auto px-4 py-8">
          <div className="space-y-4">
            <ProgressBar progress={(12 / 14) * 100} color="blue" height="md" />

            {isAnalyzing && (
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className={`px-4 py-2 rounded-full ${currentPhaseLabel.color} text-white font-bold`}>
                  {currentPhaseLabel.text}
                </div>
                {stepAlternatingState.testPhase === 'measuring' && (
                  <div className="px-3 py-1.5 rounded-full bg-pink-500/80 text-white font-medium text-sm">
                    {stepAlternatingState.stepCount}회 / 8회
                  </div>
                )}
              </div>
            )}

            <Card padding="md">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="text-white font-bold text-lg">12. 발판에 발 교대로 올리기</h3>
                  <p className="text-slate-400 text-sm">양발을 번갈아가며 발판 위에 올렸다 내리기</p>
                </div>
                <Badge variant="testType" value="BBS" size="md">AI 자동</Badge>
              </div>

              <div className="p-3 bg-pink-500/10 border border-pink-500/20 rounded-lg text-sm">
                <p className="text-pink-400 mb-2"><strong>검사 순서:</strong></p>
                <ol className="text-slate-400 space-y-1 list-decimal list-inside">
                  <li className={stepAlternatingState.testPhase !== 'waiting' ? 'text-emerald-400' : ''}>
                    발판 앞에 서기 → AI 자세 확인
                  </li>
                  <li className={stepAlternatingState.stepCount >= 4 ? 'text-emerald-400' : ''}>
                    양발을 번갈아 발판에 올리기 (8회 목표)
                  </li>
                  <li className={stepAlternatingState.testPhase === 'complete' ? 'text-emerald-400' : ''}>
                    자동 채점
                  </li>
                </ol>
              </div>
            </Card>

            {/* 항목별 영상 업로드 */}
            {inputMode === 'upload' && !isAnalyzing && (
              <DualVideoUpload
                sideFile={curVid.sideFile}
                sideUrl={curVid.sideUrl}
                onSideSelect={handleSideSelect}
                onSideRemove={handleSideRemove}
                frontFile={curVid.frontFile}
                frontUrl={curVid.frontUrl}
                onFrontSelect={handleFrontSelect}
                onFrontRemove={handleFrontRemove}
                accentColor="blue"
              />
            )}

            {/* 카메라 뷰 */}
            <div className="aspect-video bg-slate-800 rounded-2xl overflow-hidden relative">
              <video ref={videoRef} className="hidden" playsInline />
              <canvas ref={canvasRef} className="w-full h-full object-contain" />

              {!isAnalyzing && !cameraLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-900/80">
                  <div className="text-center space-y-4">
                    <div className="w-24 h-24 mx-auto rounded-full bg-pink-500/20 flex items-center justify-center">
                      <svg className="w-12 h-12 text-pink-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    </div>
                    <p className="text-slate-300">{inputMode === 'upload' && !videoUrl ? '위에서 영상을 업로드하세요' : '전신이 보이도록 카메라를 배치해주세요'}</p>
                    <Button variant="bbs" size="lg" onClick={startItem} disabled={inputMode === 'upload' && !videoUrl}>
                      {inputMode === 'upload' && !videoUrl ? '영상을 먼저 업로드하세요' : '검사 시작'}
                    </Button>
                  </div>
                </div>
              )}

              {cameraLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-900/80">
                  <div className="text-center space-y-4">
                    <div className="w-16 h-16 mx-auto border-4 border-pink-500 border-t-transparent rounded-full animate-spin" />
                    <p className="text-slate-300">카메라 초기화 중...</p>
                  </div>
                </div>
              )}

              {isAnalyzing && !cameraLoading && (
                <>
                  {/* 상단 좌측: 발 상태 표시 */}
                  <div className="absolute top-4 left-4 space-y-2">
                    <div className="flex gap-2">
                      <div className={`px-3 py-2 rounded-xl backdrop-blur-sm shadow-lg ${
                        stepAlternatingState.isLeftUp ? 'bg-pink-500' : 'bg-slate-700/80'
                      }`}>
                        <p className="text-white font-bold text-sm">
                          왼발 {stepAlternatingState.isLeftUp ? '↑' : '↓'}
                        </p>
                      </div>
                      <div className={`px-3 py-2 rounded-xl backdrop-blur-sm shadow-lg ${
                        stepAlternatingState.isRightUp ? 'bg-pink-500' : 'bg-slate-700/80'
                      }`}>
                        <p className="text-white font-bold text-sm">
                          오른발 {stepAlternatingState.isRightUp ? '↑' : '↓'}
                        </p>
                      </div>
                    </div>

                    {/* 경과 시간 */}
                    {stepAlternatingState.testPhase === 'measuring' && (
                      <div className="px-3 py-2 rounded-lg bg-slate-900/80 backdrop-blur-sm">
                        <p className="text-white font-mono text-lg">{stepAlternatingState.elapsedSec}초</p>
                      </div>
                    )}
                  </div>

                  {/* 상단 우측: 피드백 */}
                  <div className={`absolute top-4 right-4 px-4 py-3 rounded-xl backdrop-blur-sm shadow-lg max-w-[250px] ${
                    stepAlternatingState.feedback.type === 'success' ? 'bg-emerald-500' :
                    stepAlternatingState.feedback.type === 'warning' ? 'bg-yellow-500' :
                    stepAlternatingState.feedback.type === 'error' ? 'bg-red-500' :
                    'bg-pink-500'
                  }`}>
                    <p className="text-white font-bold text-lg">{stepAlternatingState.feedback.message}</p>
                  </div>

                  {/* 하단: 터치 카운터 + 진행률 */}
                  <div className="absolute bottom-4 left-4 right-4">
                    <div className="bg-slate-900/90 backdrop-blur-sm p-4 rounded-xl">
                      <div className="flex justify-between text-sm mb-2">
                        <span className="text-slate-400">터치 횟수</span>
                        <span className="text-white font-bold">{stepAlternatingState.stepCount} / 8</span>
                      </div>
                      <div className="w-full bg-slate-700 rounded-full h-3">
                        <div
                          className="bg-gradient-to-r from-pink-500 to-rose-500 h-3 rounded-full transition-all duration-500"
                          style={{ width: `${Math.min(100, (stepAlternatingState.stepCount / 8) * 100)}%` }}
                        />
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* 실시간 카운터 패널 */}
            {isAnalyzing && !stepAlternatingState.showResultModal && stepAlternatingState.testPhase === 'measuring' && (
              <Card padding="md">
                <div className="grid grid-cols-3 gap-3">
                  <div className="p-3 bg-slate-800 rounded-xl text-center">
                    <p className="text-slate-400 text-xs mb-1">총 터치</p>
                    <p className="text-white font-bold text-2xl">{stepAlternatingState.stepCount}</p>
                  </div>
                  <div className="p-3 bg-slate-800 rounded-xl text-center">
                    <p className="text-slate-400 text-xs mb-1">교대 터치</p>
                    <p className="text-pink-400 font-bold text-2xl">{stepAlternatingState.alternatingCount}</p>
                  </div>
                  <div className="p-3 bg-slate-800 rounded-xl text-center">
                    <p className="text-slate-400 text-xs mb-1">경과 시간</p>
                    <p className="text-white font-bold text-2xl">{stepAlternatingState.elapsedSec}초</p>
                  </div>
                </div>
              </Card>
            )}

            {/* 수동 완료 버튼 */}
            {isAnalyzing && !stepAlternatingState.showResultModal && stepAlternatingState.testPhase !== 'complete' && (
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  className="text-slate-400"
                  onClick={() => {
                    markStepAlternatingComplete();
                    const score = calculateStepAlternatingScore(
                      stepAlternatingState.stepCount, stepAlternatingState.alternatingCount, stepAlternatingState.elapsedSec, false
                    );
                    const report = generateStepAlternatingReport(
                      score, stepAlternatingState.stepCount, stepAlternatingState.alternatingCount, stepAlternatingState.elapsedSec
                    );
                    setStepAlternatingState(prev => ({
                      ...prev,
                      testPhase: 'complete',
                      autoScore: score,
                      assessmentReport: report,
                      showResultModal: true,
                      feedback: { message: '수동 완료', type: 'info' }
                    }));
                  }}
                >
                  수동 완료
                </Button>
              </div>
            )}

            {/* 이전/건너뛰기 */}
            {!stepAlternatingState.showResultModal && (
              <div className="flex justify-between">
                <Button
                  variant="ghost"
                  className="flex-1"
                  onClick={() => {
                    if (timerRef.current) clearInterval(timerRef.current);
                    if (animationFrameRef.current) {
                      cancelAnimationFrame(animationFrameRef.current);
                      animationFrameRef.current = null;
                    }
                    stopCamera();
                    if (videoRef.current) {
                      videoRef.current.pause();
                      videoRef.current.srcObject = null;
                      videoRef.current.onplay = null;
                      videoRef.current.onended = null;
                    }
                    setIsAnalyzing(false);
                    setItemTimer(0);
                    setCurrentLandmarks(null);
                    setCurrentItem(currentItem - 1);
                  }}
                >
                  ← 이전 항목
                </Button>
                <Button
                  variant="ghost"
                  className="flex-1 text-yellow-400 border-yellow-500/30 hover:bg-yellow-500/10"
                  onClick={() => {
                    if (timerRef.current) clearInterval(timerRef.current);
                    if (animationFrameRef.current) {
                      cancelAnimationFrame(animationFrameRef.current);
                      animationFrameRef.current = null;
                    }
                    stopCamera();
                    if (videoRef.current) {
                      videoRef.current.pause();
                      videoRef.current.srcObject = null;
                      videoRef.current.onplay = null;
                      videoRef.current.onended = null;
                    }
                    setIsAnalyzing(false);
                    setItemTimer(0);
                    setCurrentLandmarks(null);
                    setCurrentItem(currentItem + 1);
                  }}
                >
                  건너뛰기 →
                </Button>
              </div>
            )}
          </div>
        </main>

        {/* 결과 모달 */}
        {stepAlternatingState.showResultModal && stepAlternatingState.assessmentReport && (
          <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-slate-900 rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto border border-slate-700 shadow-2xl">
              <div className="p-6 text-center bg-pink-500/20">
                <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-pink-500 flex items-center justify-center">
                  <span className="text-4xl">✓</span>
                </div>
                <h2 className="text-white font-bold text-2xl mb-2">항목 12 검사 완료</h2>
                <p className="text-slate-400">발판에 발 교대로 올리기</p>
              </div>

              <div className="p-6 border-b border-slate-700">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-slate-400 text-sm">AI 자동 채점</p>
                    <p className="text-5xl font-bold text-white">
                      {stepAlternatingState.assessmentReport.scoring.autoScore}
                      <span className="text-xl text-slate-500 ml-1">/ 4점</span>
                    </p>
                  </div>
                  <div className="w-24 h-24 relative">
                    <svg className="w-24 h-24 transform -rotate-90">
                      <circle cx="48" cy="48" r="40" stroke="#334155" strokeWidth="8" fill="none" />
                      <circle
                        cx="48" cy="48" r="40"
                        stroke="#EC4899"
                        strokeWidth="8"
                        fill="none"
                        strokeDasharray={`${(stepAlternatingState.assessmentReport.scoring.autoScore / 4) * 251} 251`}
                        strokeLinecap="round"
                      />
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="text-3xl font-bold text-white">{stepAlternatingState.assessmentReport.scoring.autoScore}</span>
                    </div>
                  </div>
                </div>
                <p className="mt-3 text-lg font-medium text-pink-400">
                  {stepAlternatingState.assessmentReport.scoring.reason}
                </p>
              </div>

              <div className="p-6 space-y-4">
                <h3 className="text-white font-bold">AI 분석 결과</h3>

                <div className="grid grid-cols-3 gap-3">
                  <div className="p-3 bg-slate-800 rounded-xl text-center">
                    <p className="text-slate-400 text-xs mb-1">총 터치</p>
                    <p className="text-white font-bold text-lg">
                      {stepAlternatingState.assessmentReport.measurement.totalTouches}회
                    </p>
                  </div>
                  <div className="p-3 bg-slate-800 rounded-xl text-center">
                    <p className="text-slate-400 text-xs mb-1">교대 터치</p>
                    <p className="text-pink-400 font-bold text-lg">
                      {stepAlternatingState.assessmentReport.measurement.alternatingTouches}회
                    </p>
                  </div>
                  <div className="p-3 bg-slate-800 rounded-xl text-center">
                    <p className="text-slate-400 text-xs mb-1">소요 시간</p>
                    <p className={`font-bold text-lg ${
                      stepAlternatingState.assessmentReport.measurement.elapsedSec <= 20 ? 'text-emerald-400' : 'text-yellow-400'
                    }`}>
                      {stepAlternatingState.assessmentReport.measurement.elapsedSec}초
                    </p>
                  </div>
                </div>

                <div className="p-3 bg-slate-800/50 rounded-xl">
                  <p className="text-slate-500 text-xs font-medium mb-2">채점 기준</p>
                  <div className="space-y-1 text-xs text-slate-400">
                    <p>4점: 8회 이상, 20초 이내, 안전</p>
                    <p>3점: 8회 이상, 20초 초과</p>
                    <p>2점: 4회 이상</p>
                    <p>1점: 2회 이상</p>
                    <p>0점: 2회 미만 또는 균형 상실</p>
                  </div>
                </div>
              </div>

              <div className="p-6 bg-slate-800/50">
                <Button
                  variant="bbs"
                  size="lg"
                  fullWidth
                  onClick={() => handleScore(stepAlternatingState.assessmentReport.scoring.autoScore)}
                >
                  다음 항목으로 (항목 13) →
                </Button>
              </div>
            </div>
          </div>
        )}
      </PageContainer>
    );
  }

  // 항목 13 전용 UI
  if (isItem13) {
    const stanceLabels = { tandem: '탄뎀 (일렬)', forward: '앞뒤 자세', small_step: '작은 보폭', none: '일반 서기' };
    const stanceColors = { tandem: 'bg-emerald-500', forward: 'bg-blue-500', small_step: 'bg-yellow-500', none: 'bg-slate-600' };
    const phaseLabels = {
      waiting: { text: '서 있는 자세 대기', color: 'bg-slate-600' },
      measuring: { text: '측정 중', color: 'bg-violet-500' },
      complete: { text: '검사 완료!', color: 'bg-emerald-500' }
    };
    const currentPhaseLabel = phaseLabels[tandemStanceState.testPhase] || phaseLabels.waiting;

    return (
      <PageContainer>
        <Header title="항목 13 / 14" onBack={() => navigateTo(PAGES.HOME)} />

        <main className="max-w-4xl mx-auto px-4 py-8">
          <div className="space-y-4">
            <ProgressBar progress={(13 / 14) * 100} color="blue" height="md" />

            {isAnalyzing && (
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className={`px-4 py-2 rounded-full ${currentPhaseLabel.color} text-white font-bold`}>
                  {currentPhaseLabel.text}
                </div>
                {tandemStanceState.testPhase === 'measuring' && tandemStanceState.stanceType !== 'none' && (
                  <div className={`px-3 py-1.5 rounded-full ${stanceColors[tandemStanceState.stanceType]} text-white font-medium text-sm`}>
                    {stanceLabels[tandemStanceState.stanceType]}
                  </div>
                )}
              </div>
            )}

            <Card padding="md">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="text-white font-bold text-lg">13. 일렬로 서기 (탄뎀 서기)</h3>
                  <p className="text-slate-400 text-sm">한 발을 다른 발 바로 앞에 놓고 30초간 서 있기</p>
                </div>
                <Badge variant="testType" value="BBS" size="md">AI 자동</Badge>
              </div>

              <div className="p-3 bg-violet-500/10 border border-violet-500/20 rounded-lg text-sm">
                <p className="text-violet-400 mb-2"><strong>검사 순서:</strong></p>
                <ol className="text-slate-400 space-y-1 list-decimal list-inside">
                  <li className={tandemStanceState.testPhase !== 'waiting' ? 'text-emerald-400' : ''}>
                    바르게 서기 → AI 자세 확인
                  </li>
                  <li className={tandemStanceState.stanceType !== 'none' ? 'text-emerald-400' : ''}>
                    한 발을 다른 발 앞에 일렬로 놓기
                  </li>
                  <li className={tandemStanceState.maxDuration >= 30 ? 'text-emerald-400' : ''}>
                    30초간 유지 → 자동 채점
                  </li>
                </ol>
              </div>
            </Card>

            {/* 항목별 영상 업로드 */}
            {inputMode === 'upload' && !isAnalyzing && (
              <DualVideoUpload
                sideFile={curVid.sideFile}
                sideUrl={curVid.sideUrl}
                onSideSelect={handleSideSelect}
                onSideRemove={handleSideRemove}
                frontFile={curVid.frontFile}
                frontUrl={curVid.frontUrl}
                onFrontSelect={handleFrontSelect}
                onFrontRemove={handleFrontRemove}
                accentColor="blue"
              />
            )}

            {/* 카메라 뷰 */}
            <div className="aspect-video bg-slate-800 rounded-2xl overflow-hidden relative">
              <video ref={videoRef} className="hidden" playsInline />
              <canvas ref={canvasRef} className="w-full h-full object-contain" />

              {!isAnalyzing && !cameraLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-900/80">
                  <div className="text-center space-y-4">
                    <div className="w-24 h-24 mx-auto rounded-full bg-violet-500/20 flex items-center justify-center">
                      <svg className="w-12 h-12 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    </div>
                    <p className="text-slate-300">{inputMode === 'upload' && !videoUrl ? '위에서 영상을 업로드하세요' : '전신이 보이도록 카메라를 배치해주세요'}</p>
                    <Button variant="bbs" size="lg" onClick={startItem} disabled={inputMode === 'upload' && !videoUrl}>
                      {inputMode === 'upload' && !videoUrl ? '영상을 먼저 업로드하세요' : '검사 시작'}
                    </Button>
                  </div>
                </div>
              )}

              {cameraLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-900/80">
                  <div className="text-center space-y-4">
                    <div className="w-16 h-16 mx-auto border-4 border-violet-500 border-t-transparent rounded-full animate-spin" />
                    <p className="text-slate-300">카메라 초기화 중...</p>
                  </div>
                </div>
              )}

              {isAnalyzing && !cameraLoading && (
                <>
                  {/* 상단 좌측: 자세 유형 + 유지 시간 */}
                  <div className="absolute top-4 left-4 space-y-2">
                    <div className={`px-4 py-2 rounded-xl backdrop-blur-sm shadow-lg ${
                      stanceColors[tandemStanceState.stanceType] || 'bg-slate-700/80'
                    }`}>
                      <p className="text-white font-bold text-lg">
                        {stanceLabels[tandemStanceState.stanceType]}
                      </p>
                    </div>

                    {tandemStanceState.testPhase === 'measuring' && tandemStanceState.stanceType !== 'none' && (
                      <div className="px-3 py-2 rounded-lg bg-slate-900/80 backdrop-blur-sm">
                        <p className="text-white font-mono text-lg">{tandemStanceState.stanceDuration}초 / 30초</p>
                      </div>
                    )}
                  </div>

                  {/* 상단 우측: 피드백 */}
                  <div className={`absolute top-4 right-4 px-4 py-3 rounded-xl backdrop-blur-sm shadow-lg max-w-[250px] ${
                    tandemStanceState.feedback.type === 'success' ? 'bg-emerald-500' :
                    tandemStanceState.feedback.type === 'warning' ? 'bg-yellow-500' :
                    tandemStanceState.feedback.type === 'error' ? 'bg-red-500' :
                    'bg-violet-500'
                  }`}>
                    <p className="text-white font-bold text-lg">{tandemStanceState.feedback.message}</p>
                  </div>

                  {/* 하단: 타이머 진행률 */}
                  <div className="absolute bottom-4 left-4 right-4">
                    <div className="bg-slate-900/90 backdrop-blur-sm p-4 rounded-xl">
                      <div className="flex justify-between text-sm mb-2">
                        <span className="text-slate-400">유지 시간</span>
                        <span className="text-white font-bold">{tandemStanceState.maxDuration}초 / 30초</span>
                      </div>
                      <div className="w-full bg-slate-700 rounded-full h-3">
                        <div
                          className="bg-gradient-to-r from-violet-500 to-purple-500 h-3 rounded-full transition-all duration-500"
                          style={{ width: `${Math.min(100, (tandemStanceState.maxDuration / 30) * 100)}%` }}
                        />
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* 실시간 상태 패널 */}
            {isAnalyzing && !tandemStanceState.showResultModal && tandemStanceState.testPhase === 'measuring' && (
              <Card padding="md">
                <div className="grid grid-cols-3 gap-3">
                  <div className="p-3 bg-slate-800 rounded-xl text-center">
                    <p className="text-slate-400 text-xs mb-1">현재 자세</p>
                    <p className={`font-bold text-sm ${
                      tandemStanceState.stanceType === 'tandem' ? 'text-emerald-400' :
                      tandemStanceState.stanceType === 'forward' ? 'text-blue-400' :
                      tandemStanceState.stanceType === 'small_step' ? 'text-yellow-400' :
                      'text-slate-500'
                    }`}>
                      {stanceLabels[tandemStanceState.stanceType]}
                    </p>
                  </div>
                  <div className="p-3 bg-slate-800 rounded-xl text-center">
                    <p className="text-slate-400 text-xs mb-1">최고 자세</p>
                    <p className={`font-bold text-sm ${
                      tandemStanceState.bestStanceType === 'tandem' ? 'text-emerald-400' :
                      tandemStanceState.bestStanceType === 'forward' ? 'text-blue-400' :
                      tandemStanceState.bestStanceType === 'small_step' ? 'text-yellow-400' :
                      'text-slate-500'
                    }`}>
                      {stanceLabels[tandemStanceState.bestStanceType]}
                    </p>
                  </div>
                  <div className="p-3 bg-slate-800 rounded-xl text-center">
                    <p className="text-slate-400 text-xs mb-1">최대 유지</p>
                    <p className="text-white font-bold text-2xl">{tandemStanceState.maxDuration}초</p>
                  </div>
                </div>
              </Card>
            )}

            {/* 수동 완료 버튼 */}
            {isAnalyzing && !tandemStanceState.showResultModal && tandemStanceState.testPhase !== 'complete' && (
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  className="text-slate-400"
                  onClick={() => {
                    markTandemStanceComplete();
                    const score = calculateTandemStanceScore(
                      tandemStanceState.bestStanceType, tandemStanceState.maxDuration, false
                    );
                    const report = generateTandemStanceReport(
                      score, tandemStanceState.bestStanceType, tandemStanceState.maxDuration, tandemStanceState.feetXGap
                    );
                    setTandemStanceState(prev => ({
                      ...prev,
                      testPhase: 'complete',
                      autoScore: score,
                      assessmentReport: report,
                      showResultModal: true,
                      feedback: { message: '수동 완료', type: 'info' }
                    }));
                  }}
                >
                  수동 완료
                </Button>
              </div>
            )}

            {/* 이전/건너뛰기 */}
            {!tandemStanceState.showResultModal && (
              <div className="flex justify-between">
                <Button
                  variant="ghost"
                  className="flex-1"
                  onClick={() => {
                    if (timerRef.current) clearInterval(timerRef.current);
                    if (animationFrameRef.current) {
                      cancelAnimationFrame(animationFrameRef.current);
                      animationFrameRef.current = null;
                    }
                    stopCamera();
                    if (videoRef.current) {
                      videoRef.current.pause();
                      videoRef.current.srcObject = null;
                      videoRef.current.onplay = null;
                      videoRef.current.onended = null;
                    }
                    setIsAnalyzing(false);
                    setItemTimer(0);
                    setCurrentLandmarks(null);
                    setCurrentItem(currentItem - 1);
                  }}
                >
                  ← 이전 항목
                </Button>
                <Button
                  variant="ghost"
                  className="flex-1 text-yellow-400 border-yellow-500/30 hover:bg-yellow-500/10"
                  onClick={() => {
                    if (timerRef.current) clearInterval(timerRef.current);
                    if (animationFrameRef.current) {
                      cancelAnimationFrame(animationFrameRef.current);
                      animationFrameRef.current = null;
                    }
                    stopCamera();
                    if (videoRef.current) {
                      videoRef.current.pause();
                      videoRef.current.srcObject = null;
                      videoRef.current.onplay = null;
                      videoRef.current.onended = null;
                    }
                    setIsAnalyzing(false);
                    setItemTimer(0);
                    setCurrentLandmarks(null);
                    setCurrentItem(currentItem + 1);
                  }}
                >
                  건너뛰기 →
                </Button>
              </div>
            )}
          </div>
        </main>

        {/* 결과 모달 */}
        {tandemStanceState.showResultModal && tandemStanceState.assessmentReport && (
          <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-slate-900 rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto border border-slate-700 shadow-2xl">
              <div className="p-6 text-center bg-violet-500/20">
                <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-violet-500 flex items-center justify-center">
                  <span className="text-4xl">✓</span>
                </div>
                <h2 className="text-white font-bold text-2xl mb-2">항목 13 검사 완료</h2>
                <p className="text-slate-400">일렬로 서기 (탄뎀 서기)</p>
              </div>

              <div className="p-6 border-b border-slate-700">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-slate-400 text-sm">AI 자동 채점</p>
                    <p className="text-5xl font-bold text-white">
                      {tandemStanceState.assessmentReport.scoring.autoScore}
                      <span className="text-xl text-slate-500 ml-1">/ 4점</span>
                    </p>
                  </div>
                  <div className="w-24 h-24 relative">
                    <svg className="w-24 h-24 transform -rotate-90">
                      <circle cx="48" cy="48" r="40" stroke="#334155" strokeWidth="8" fill="none" />
                      <circle
                        cx="48" cy="48" r="40"
                        stroke="#8B5CF6"
                        strokeWidth="8"
                        fill="none"
                        strokeDasharray={`${(tandemStanceState.assessmentReport.scoring.autoScore / 4) * 251} 251`}
                        strokeLinecap="round"
                      />
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="text-3xl font-bold text-white">{tandemStanceState.assessmentReport.scoring.autoScore}</span>
                    </div>
                  </div>
                </div>
                <p className="mt-3 text-lg font-medium text-violet-400">
                  {tandemStanceState.assessmentReport.scoring.reason}
                </p>
              </div>

              <div className="p-6 space-y-4">
                <h3 className="text-white font-bold">AI 분석 결과</h3>

                <div className="grid grid-cols-2 gap-3">
                  <div className="p-3 bg-slate-800 rounded-xl text-center">
                    <p className="text-slate-400 text-xs mb-1">최고 자세</p>
                    <p className={`font-bold text-lg ${
                      tandemStanceState.assessmentReport.measurement.bestStanceType === 'tandem' ? 'text-emerald-400' :
                      tandemStanceState.assessmentReport.measurement.bestStanceType === 'forward' ? 'text-blue-400' :
                      'text-yellow-400'
                    }`}>
                      {tandemStanceState.assessmentReport.measurement.bestStanceLabel}
                    </p>
                  </div>
                  <div className="p-3 bg-slate-800 rounded-xl text-center">
                    <p className="text-slate-400 text-xs mb-1">최대 유지 시간</p>
                    <p className={`font-bold text-lg ${
                      tandemStanceState.assessmentReport.measurement.maxDuration >= 30 ? 'text-emerald-400' : 'text-yellow-400'
                    }`}>
                      {tandemStanceState.assessmentReport.measurement.maxDuration}초
                    </p>
                  </div>
                </div>

                <div className="p-3 bg-slate-800/50 rounded-xl">
                  <p className="text-slate-500 text-xs font-medium mb-2">채점 기준</p>
                  <div className="space-y-1 text-xs text-slate-400">
                    <p>4점: 탄뎀 자세로 30초 유지</p>
                    <p>3점: 앞뒤 자세로 30초 유지</p>
                    <p>2점: 작은 보폭으로 30초 유지</p>
                    <p>1점: 15초 유지</p>
                    <p>0점: 균형 상실</p>
                  </div>
                </div>
              </div>

              <div className="p-6 bg-slate-800/50">
                <Button
                  variant="bbs"
                  size="lg"
                  fullWidth
                  onClick={() => handleScore(tandemStanceState.assessmentReport.scoring.autoScore)}
                >
                  다음 항목으로 (항목 14) →
                </Button>
              </div>
            </div>
          </div>
        )}
      </PageContainer>
    );
  }

  // 항목 14 전용 UI
  if (isItem14) {
    const phaseLabels = {
      waiting: { text: '서 있는 자세 대기', color: 'bg-slate-600' },
      measuring: { text: '측정 중', color: 'bg-amber-500' },
      complete: { text: '검사 완료!', color: 'bg-emerald-500' }
    };
    const currentPhaseLabel = phaseLabels[singleLegState.testPhase] || phaseLabels.waiting;

    return (
      <PageContainer>
        <Header title="항목 14 / 14" onBack={() => navigateTo(PAGES.HOME)} />

        <main className="max-w-4xl mx-auto px-4 py-8">
          <div className="space-y-4">
            <ProgressBar progress={(14 / 14) * 100} color="blue" height="md" />

            {isAnalyzing && (
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className={`px-4 py-2 rounded-full ${currentPhaseLabel.color} text-white font-bold`}>
                  {currentPhaseLabel.text}
                </div>
                {singleLegState.liftedFoot && singleLegState.testPhase === 'measuring' && (
                  <div className="px-3 py-1.5 rounded-full bg-amber-500/80 text-white font-medium text-sm">
                    {singleLegState.liftedFoot === 'left' ? '왼발' : '오른발'} 들기 중
                  </div>
                )}
              </div>
            )}

            <Card padding="md">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="text-white font-bold text-lg">14. 한 발로 서기</h3>
                  <p className="text-slate-400 text-sm">지지 없이 한 발로 최대한 오래 서 있기</p>
                </div>
                <Badge variant="testType" value="BBS" size="md">AI 자동</Badge>
              </div>

              <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg text-sm">
                <p className="text-amber-400 mb-2"><strong>검사 순서:</strong></p>
                <ol className="text-slate-400 space-y-1 list-decimal list-inside">
                  <li className={singleLegState.testPhase !== 'waiting' ? 'text-emerald-400' : ''}>
                    바르게 서기 → AI 자세 확인
                  </li>
                  <li className={singleLegState.maxDuration > 0 ? 'text-emerald-400' : ''}>
                    한 발 들고 최대한 오래 유지 (목표 10초)
                  </li>
                  <li className={singleLegState.testPhase === 'complete' ? 'text-emerald-400' : ''}>
                    자동 채점
                  </li>
                </ol>
              </div>
            </Card>

            {/* 항목별 영상 업로드 */}
            {inputMode === 'upload' && !isAnalyzing && (
              <DualVideoUpload
                sideFile={curVid.sideFile}
                sideUrl={curVid.sideUrl}
                onSideSelect={handleSideSelect}
                onSideRemove={handleSideRemove}
                frontFile={curVid.frontFile}
                frontUrl={curVid.frontUrl}
                onFrontSelect={handleFrontSelect}
                onFrontRemove={handleFrontRemove}
                accentColor="blue"
              />
            )}

            {/* 카메라 뷰 */}
            <div className="aspect-video bg-slate-800 rounded-2xl overflow-hidden relative">
              <video ref={videoRef} className="hidden" playsInline />
              <canvas ref={canvasRef} className="w-full h-full object-contain" />

              {!isAnalyzing && !cameraLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-900/80">
                  <div className="text-center space-y-4">
                    <div className="w-24 h-24 mx-auto rounded-full bg-amber-500/20 flex items-center justify-center">
                      <svg className="w-12 h-12 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    </div>
                    <p className="text-slate-300">{inputMode === 'upload' && !videoUrl ? '위에서 영상을 업로드하세요' : '전신이 보이도록 카메라를 배치해주세요'}</p>
                    <Button variant="bbs" size="lg" onClick={startItem} disabled={inputMode === 'upload' && !videoUrl}>
                      {inputMode === 'upload' && !videoUrl ? '영상을 먼저 업로드하세요' : '검사 시작'}
                    </Button>
                  </div>
                </div>
              )}

              {cameraLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-900/80">
                  <div className="text-center space-y-4">
                    <div className="w-16 h-16 mx-auto border-4 border-amber-500 border-t-transparent rounded-full animate-spin" />
                    <p className="text-slate-300">카메라 초기화 중...</p>
                  </div>
                </div>
              )}

              {isAnalyzing && !cameraLoading && (
                <>
                  {/* 상단 좌측: 들고 있는 발 + 시간 */}
                  <div className="absolute top-4 left-4 space-y-2">
                    <div className={`px-4 py-2 rounded-xl backdrop-blur-sm shadow-lg ${
                      singleLegState.liftedFoot ? 'bg-amber-500' : 'bg-slate-700/80'
                    }`}>
                      <p className="text-white font-bold text-lg">
                        {singleLegState.liftedFoot
                          ? `${singleLegState.liftedFoot === 'left' ? '왼발' : '오른발'} 들기`
                          : '양발 서기'}
                      </p>
                    </div>

                    {singleLegState.testPhase === 'measuring' && singleLegState.liftedFoot && (
                      <div className="px-3 py-2 rounded-lg bg-slate-900/80 backdrop-blur-sm">
                        <p className="text-white font-mono text-lg">{singleLegState.liftDuration}초 / 10초</p>
                      </div>
                    )}
                  </div>

                  {/* 상단 우측: 피드백 */}
                  <div className={`absolute top-4 right-4 px-4 py-3 rounded-xl backdrop-blur-sm shadow-lg max-w-[250px] ${
                    singleLegState.feedback.type === 'success' ? 'bg-emerald-500' :
                    singleLegState.feedback.type === 'warning' ? 'bg-yellow-500' :
                    singleLegState.feedback.type === 'error' ? 'bg-red-500' :
                    'bg-amber-500'
                  }`}>
                    <p className="text-white font-bold text-lg">{singleLegState.feedback.message}</p>
                  </div>

                  {/* 하단: 타이머 진행률 */}
                  <div className="absolute bottom-4 left-4 right-4">
                    <div className="bg-slate-900/90 backdrop-blur-sm p-4 rounded-xl">
                      <div className="flex justify-between text-sm mb-2">
                        <span className="text-slate-400">최대 유지</span>
                        <span className="text-white font-bold">{singleLegState.maxDuration}초 / 10초</span>
                      </div>
                      <div className="w-full bg-slate-700 rounded-full h-3">
                        <div
                          className="bg-gradient-to-r from-amber-500 to-orange-500 h-3 rounded-full transition-all duration-500"
                          style={{ width: `${Math.min(100, (singleLegState.maxDuration / 10) * 100)}%` }}
                        />
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* 실시간 상태 패널 */}
            {isAnalyzing && !singleLegState.showResultModal && singleLegState.testPhase === 'measuring' && (
              <Card padding="md">
                <div className="grid grid-cols-3 gap-3">
                  <div className="p-3 bg-slate-800 rounded-xl text-center">
                    <p className="text-slate-400 text-xs mb-1">현재 상태</p>
                    <p className={`font-bold text-sm ${singleLegState.liftedFoot ? 'text-amber-400' : 'text-slate-500'}`}>
                      {singleLegState.liftedFoot
                        ? `${singleLegState.liftedFoot === 'left' ? '왼발' : '오른발'} 들기`
                        : '양발 서기'}
                    </p>
                  </div>
                  <div className="p-3 bg-slate-800 rounded-xl text-center">
                    <p className="text-slate-400 text-xs mb-1">현재 유지</p>
                    <p className="text-white font-bold text-2xl">{singleLegState.liftDuration}초</p>
                  </div>
                  <div className="p-3 bg-slate-800 rounded-xl text-center">
                    <p className="text-slate-400 text-xs mb-1">최대 유지</p>
                    <p className="text-amber-400 font-bold text-2xl">{singleLegState.maxDuration}초</p>
                  </div>
                </div>
              </Card>
            )}

            {/* 수동 완료 버튼 */}
            {isAnalyzing && !singleLegState.showResultModal && singleLegState.testPhase !== 'complete' && (
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  className="text-slate-400"
                  onClick={() => {
                    markSingleLegStanceComplete();
                    const attempted = singleLegState.maxDuration > 0;
                    const score = calculateSingleLegStanceScore(singleLegState.maxDuration, attempted, false);
                    const report = generateSingleLegStanceReport(
                      score, singleLegState.maxDuration, singleLegState.bestLiftedFoot
                    );
                    setSingleLegState(prev => ({
                      ...prev,
                      testPhase: 'complete',
                      autoScore: score,
                      assessmentReport: report,
                      showResultModal: true,
                      feedback: { message: '수동 완료', type: 'info' }
                    }));
                  }}
                >
                  수동 완료
                </Button>
              </div>
            )}

            {/* 이전/건너뛰기 */}
            {!singleLegState.showResultModal && (
              <div className="flex justify-between">
                <Button
                  variant="ghost"
                  className="flex-1"
                  onClick={() => {
                    if (timerRef.current) clearInterval(timerRef.current);
                    if (animationFrameRef.current) {
                      cancelAnimationFrame(animationFrameRef.current);
                      animationFrameRef.current = null;
                    }
                    stopCamera();
                    if (videoRef.current) {
                      videoRef.current.pause();
                      videoRef.current.srcObject = null;
                      videoRef.current.onplay = null;
                      videoRef.current.onended = null;
                    }
                    setIsAnalyzing(false);
                    setItemTimer(0);
                    setCurrentLandmarks(null);
                    setCurrentItem(currentItem - 1);
                  }}
                >
                  ← 이전 항목
                </Button>
                <Button
                  variant="ghost"
                  className="flex-1 text-yellow-400 border-yellow-500/30 hover:bg-yellow-500/10"
                  onClick={() => {
                    if (timerRef.current) clearInterval(timerRef.current);
                    if (animationFrameRef.current) {
                      cancelAnimationFrame(animationFrameRef.current);
                      animationFrameRef.current = null;
                    }
                    stopCamera();
                    if (videoRef.current) {
                      videoRef.current.pause();
                      videoRef.current.srcObject = null;
                      videoRef.current.onplay = null;
                      videoRef.current.onended = null;
                    }
                    setIsAnalyzing(false);
                    setItemTimer(0);
                    setCurrentLandmarks(null);
                    setCurrentItem(currentItem + 1);
                  }}
                >
                  건너뛰기 →
                </Button>
              </div>
            )}
          </div>
        </main>

        {/* 결과 모달 */}
        {singleLegState.showResultModal && singleLegState.assessmentReport && (
          <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-slate-900 rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto border border-slate-700 shadow-2xl">
              <div className="p-6 text-center bg-amber-500/20">
                <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-amber-500 flex items-center justify-center">
                  <span className="text-4xl">✓</span>
                </div>
                <h2 className="text-white font-bold text-2xl mb-2">항목 14 검사 완료</h2>
                <p className="text-slate-400">한 발로 서기 (마지막 항목)</p>
              </div>

              <div className="p-6 border-b border-slate-700">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-slate-400 text-sm">AI 자동 채점</p>
                    <p className="text-5xl font-bold text-white">
                      {singleLegState.assessmentReport.scoring.autoScore}
                      <span className="text-xl text-slate-500 ml-1">/ 4점</span>
                    </p>
                  </div>
                  <div className="w-24 h-24 relative">
                    <svg className="w-24 h-24 transform -rotate-90">
                      <circle cx="48" cy="48" r="40" stroke="#334155" strokeWidth="8" fill="none" />
                      <circle
                        cx="48" cy="48" r="40"
                        stroke="#F59E0B"
                        strokeWidth="8"
                        fill="none"
                        strokeDasharray={`${(singleLegState.assessmentReport.scoring.autoScore / 4) * 251} 251`}
                        strokeLinecap="round"
                      />
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="text-3xl font-bold text-white">{singleLegState.assessmentReport.scoring.autoScore}</span>
                    </div>
                  </div>
                </div>
                <p className="mt-3 text-lg font-medium text-amber-400">
                  {singleLegState.assessmentReport.scoring.reason}
                </p>
              </div>

              <div className="p-6 space-y-4">
                <h3 className="text-white font-bold">AI 분석 결과</h3>

                <div className="grid grid-cols-2 gap-3">
                  <div className="p-3 bg-slate-800 rounded-xl text-center">
                    <p className="text-slate-400 text-xs mb-1">들었던 발</p>
                    <p className="text-white font-bold text-lg">
                      {singleLegState.assessmentReport.measurement.liftedFootLabel}
                    </p>
                  </div>
                  <div className="p-3 bg-slate-800 rounded-xl text-center">
                    <p className="text-slate-400 text-xs mb-1">최대 유지 시간</p>
                    <p className={`font-bold text-lg ${
                      singleLegState.assessmentReport.measurement.maxDuration >= 10 ? 'text-emerald-400' :
                      singleLegState.assessmentReport.measurement.maxDuration >= 5 ? 'text-blue-400' :
                      'text-yellow-400'
                    }`}>
                      {singleLegState.assessmentReport.measurement.maxDuration}초
                    </p>
                  </div>
                </div>

                <div className="p-3 bg-slate-800/50 rounded-xl">
                  <p className="text-slate-500 text-xs font-medium mb-2">채점 기준</p>
                  <div className="space-y-1 text-xs text-slate-400">
                    <p>4점: 10초 이상 유지</p>
                    <p>3점: 5~10초 유지</p>
                    <p>2점: 3~5초 유지</p>
                    <p>1점: 시도했지만 3초 미만</p>
                    <p>0점: 시도 불가</p>
                  </div>
                </div>
              </div>

              <div className="p-6 bg-slate-800/50">
                <Button
                  variant="bbs"
                  size="lg"
                  fullWidth
                  onClick={() => handleScore(singleLegState.assessmentReport.scoring.autoScore)}
                >
                  검사 완료 → 결과 보기
                </Button>
              </div>
            </div>
          </div>
        )}
      </PageContainer>
    );
  }

  // 일반 항목 UI (항목 3-7)
  return (
    <PageContainer>
      <Header title={`항목 ${currentItem + 1} / 14`} onBack={() => navigateTo(PAGES.HOME)} />

      <main className="max-w-4xl mx-auto px-4 py-8">
        <div className="space-y-4">
          <ProgressBar progress={((currentItem + 1) / 14) * 100} color="blue" height="md" />

          <Card padding="md">
            <div className="flex items-start justify-between mb-3">
              <div>
                <h3 className="text-white font-bold text-lg">
                  {currentBBSItem.id}. {currentBBSItem.name}
                </h3>
                <p className="text-slate-400 text-sm">{currentBBSItem.desc}</p>
              </div>
              {currentBBSItem.duration > 0 && (
                <Badge variant="testType" value="BBS" size="md">{currentBBSItem.duration}초</Badge>
              )}
            </div>

            <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg">
              <p className="text-blue-400 text-sm">
                <strong>지시:</strong> {currentBBSItem.instruction}
              </p>
            </div>
          </Card>

          {/* 항목별 영상 업로드 (업로드 모드이고 분석 전) */}
          {inputMode === 'upload' && !isAnalyzing && (
            <DualVideoUpload
              sideFile={curVid.sideFile}
              sideUrl={curVid.sideUrl}
              onSideSelect={handleSideSelect}
              onSideRemove={handleSideRemove}
              frontFile={curVid.frontFile}
              frontUrl={curVid.frontUrl}
              onFrontSelect={handleFrontSelect}
              onFrontRemove={handleFrontRemove}
              accentColor="blue"
            />
          )}

          <div className="aspect-video bg-slate-800 rounded-2xl overflow-hidden relative">
            <video ref={videoRef} className="hidden" playsInline />
            <canvas ref={canvasRef} className="w-full h-full object-contain" />

            {!isAnalyzing && (
              <div className="absolute inset-0 flex items-center justify-center bg-slate-900/80">
                <Button variant="bbs" size="lg" onClick={startItem} disabled={inputMode === 'upload' && !videoUrl}>
                  {inputMode === 'upload' && !videoUrl ? '영상을 먼저 업로드하세요' : '항목 시작'}
                </Button>
              </div>
            )}

            {/* 영상 분석 중 표시 */}
            {videoAnalyzing && isAnalyzing && (
              <div className="absolute top-0 left-0 right-0 bg-blue-600/90 backdrop-blur-sm px-4 py-2 z-10">
                <div className="flex items-center gap-3">
                  <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span className="text-white font-medium text-sm">동영상 분석 중...</span>
                  <span className="text-blue-200 text-sm ml-auto">{videoProgress}%</span>
                </div>
                <div className="w-full bg-blue-800 rounded-full h-1.5 mt-1">
                  <div className="bg-white h-1.5 rounded-full transition-all" style={{ width: `${videoProgress}%` }} />
                </div>
              </div>
            )}

            {isAnalyzing && (
              <>
                {currentBBSItem.duration > 0 && (
                  <div className="absolute top-4 left-4 bg-slate-900/80 px-4 py-2 rounded-full">
                    <span className="text-white font-mono text-xl">
                      {itemTimer.toFixed(1)}초 / {currentBBSItem.duration}초
                    </span>
                  </div>
                )}

                <div className="absolute top-4 right-4 bg-slate-900/80 px-4 py-2 rounded-xl text-right">
                  <p className="text-blue-400 font-medium">{generalDetection.status}</p>
                  {generalDetection.message && (
                    <p className="text-slate-400 text-xs">{generalDetection.message}</p>
                  )}
                </div>

                <div className="absolute bottom-4 left-4 right-4">
                  <div className="bg-slate-900/80 p-3 rounded-xl">
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-slate-400">감지 신뢰도</span>
                      <span className="text-blue-400">{Math.round(generalDetection.confidence)}%</span>
                    </div>
                    <div className="w-full bg-slate-700 rounded-full h-2">
                      <div
                        className="bg-gradient-to-r from-blue-500 to-indigo-500 h-2 rounded-full transition-all"
                        style={{ width: `${generalDetection.confidence}%` }}
                      />
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>

          <Card padding="md">
            <h4 className="text-white font-semibold mb-3">점수 선택</h4>

            {generalDetection.suggestedScore !== null && (
              <div className="mb-4 p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
                <p className="text-emerald-400 text-sm">
                  <strong>AI 추천 점수:</strong> {generalDetection.suggestedScore}점
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-2 text-emerald-400"
                    onClick={() => handleScore(generalDetection.suggestedScore)}
                  >
                    적용
                  </Button>
                </p>
              </div>
            )}

            <div className="space-y-2">
              {currentBBSItem.scoring.map((option) => (
                <button
                  key={option.score}
                  onClick={() => handleScore(option.score)}
                  className={`w-full p-3 border rounded-xl text-left transition-all flex items-center gap-3
                    ${generalDetection.suggestedScore === option.score
                      ? 'bg-blue-500/20 border-blue-500/50'
                      : 'bg-slate-800/50 border-slate-700/50 hover:bg-blue-500/10 hover:border-blue-500/30'
                    }`}
                >
                  <span className="w-8 h-8 bg-blue-500/20 rounded-lg flex items-center justify-center text-blue-400 font-bold">
                    {option.score}
                  </span>
                  <span className="text-slate-300 text-sm flex-1">{option.desc}</span>
                </button>
              ))}
            </div>
          </Card>

          <div className="flex gap-4">
            {currentItem > 0 && (
              <Button
                variant="ghost"
                className="flex-1"
                onClick={() => {
                  if (timerRef.current) clearInterval(timerRef.current);
                  if (animationFrameRef.current) {
                    cancelAnimationFrame(animationFrameRef.current);
                    animationFrameRef.current = null;
                  }
                  stopCamera();
                  if (videoRef.current) {
                    videoRef.current.pause();
                    videoRef.current.srcObject = null;
                    videoRef.current.onplay = null;
                    videoRef.current.onended = null;
                  }
                  setIsAnalyzing(false);
                  setCurrentItem(currentItem - 1);
                }}
              >
                이전 항목
              </Button>
            )}
            {currentItem < 13 && (
              <Button
                variant="ghost"
                className="flex-1 text-yellow-400 border-yellow-500/30 hover:bg-yellow-500/10"
                onClick={() => {
                  if (timerRef.current) clearInterval(timerRef.current);
                  if (animationFrameRef.current) {
                    cancelAnimationFrame(animationFrameRef.current);
                    animationFrameRef.current = null;
                  }
                  stopCamera();
                  if (videoRef.current) {
                    videoRef.current.pause();
                    videoRef.current.srcObject = null;
                    videoRef.current.onplay = null;
                    videoRef.current.onended = null;
                  }
                  setIsAnalyzing(false);
                  setItemTimer(0);
                  setCurrentLandmarks(null);
                  setCurrentItem(currentItem + 1);
                }}
              >
                건너뛰기 →
              </Button>
            )}
          </div>
        </div>
      </main>
    </PageContainer>
  );
}

export default BBSTestPage;
