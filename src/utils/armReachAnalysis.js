/**
 * BBS 항목 8 - 팔 뻗어 앞으로 내밀기 (Functional Reach Test)
 *
 * 측면/정면 모두 지원:
 *  - 측면: 손목 x변위로 측정 (가장 정확)
 *  - 정면: 어깨 중심 대비 전방 기울기(shoulder-hip x offset 변화)로 추정
 *
 * bodyCalibration을 통해 환자 키 기반 실측 cm 환산.
 * 캘리브레이션 미수행 시 몸통 높이 기반 추정치 사용 (폴백).
 */

import { getCalibration, horizontalCm } from './bodyCalibration';

// ── 모듈 상태 ──
let initialState = null;
let maxReachCm = 0;
let reachHistory = [];
let completed = false;
let feetEverMoved = false;

/**
 * 분석 상태 초기화
 */
export function resetArmReachAnalysis() {
  initialState = null;
  maxReachCm = 0;
  reachHistory = [];
  completed = false;
  feetEverMoved = false;
}

/**
 * 측정 완료 표시 (이후 분석 중단)
 */
export function markArmReachComplete() {
  completed = true;
}

// ── 유틸 ──

function calcAngle(a, b, c) {
  const ba = { x: a.x - b.x, y: a.y - b.y };
  const bc = { x: c.x - b.x, y: c.y - b.y };
  const dot = ba.x * bc.x + ba.y * bc.y;
  const magBA = Math.hypot(ba.x, ba.y);
  const magBC = Math.hypot(bc.x, bc.y);
  if (magBA === 0 || magBC === 0) return 0;
  return Math.acos(Math.max(-1, Math.min(1, dot / (magBA * magBC)))) * (180 / Math.PI);
}

/**
 * 촬영 방향 판정 (정면 vs 측면)
 */
function detectViewAngle(landmarks) {
  const lShoulder = landmarks[11], rShoulder = landmarks[12];
  const shoulderXGap = Math.abs(lShoulder.x - rShoulder.x);
  return shoulderXGap >= 0.12 ? 'front' : 'side';
}

/**
 * 활성 팔 결정
 */
function pickActiveArm(landmarks) {
  const lShoulder = landmarks[11], rShoulder = landmarks[12];
  const lElbow = landmarks[13], rElbow = landmarks[14];
  const lWrist = landmarks[15], rWrist = landmarks[16];
  const lHip = landmarks[23], rHip = landmarks[24];

  const midX = (lShoulder.x + rShoulder.x) / 2;
  const lExt = Math.abs(lWrist.x - midX);
  const rExt = Math.abs(rWrist.x - midX);

  const lShoulderAngle = calcAngle(lHip, lShoulder, lElbow);
  const rShoulderAngle = calcAngle(rHip, rShoulder, rElbow);
  const lElbowAngle = calcAngle(lShoulder, lElbow, lWrist);
  const rElbowAngle = calcAngle(rShoulder, rElbow, rWrist);

  const lScore = lExt + (lShoulderAngle >= 50 && lShoulderAngle <= 140 ? 0.2 : 0) + (lElbowAngle >= 130 ? 0.1 : 0);
  const rScore = rExt + (rShoulderAngle >= 50 && rShoulderAngle <= 140 ? 0.2 : 0) + (rElbowAngle >= 130 ? 0.1 : 0);

  return lScore >= rScore;
}

/**
 * 지정된 팔의 정보 반환
 */
function getArmData(landmarks, useLeft) {
  const shoulder = useLeft ? landmarks[11] : landmarks[12];
  const elbow = useLeft ? landmarks[13] : landmarks[14];
  const wrist = useLeft ? landmarks[15] : landmarks[16];
  const hip = useLeft ? landmarks[23] : landmarks[24];

  const shoulderAngle = calcAngle(hip, shoulder, elbow);
  const elbowAngle = calcAngle(shoulder, elbow, wrist);

  return { shoulder, elbow, wrist, hip, shoulderAngle, elbowAngle };
}

/**
 * 팔이 들려있는지 판정
 */
function isArmRaisedCheck(arm, torsoHeight) {
  const wristNearShoulderHeight = Math.abs(arm.wrist.y - arm.shoulder.y) < torsoHeight * 0.35;
  const elbowStraight = arm.elbowAngle >= 120;
  return wristNearShoulderHeight && elbowStraight;
}

/**
 * 정규화 x변위 → cm 변환
 * 캘리브레이션이 있으면 실측 스케일 사용, 없으면 몸통 높이 기반 폴백
 */
function dxToCm(dx, refTorso, ar) {
  const cal = getCalibration();
  if (cal) {
    // 캘리브레이션 기반 정밀 변환
    return horizontalCm(dx);
  }
  // 폴백: 몸통 기반 추정 (ESTIMATED_TORSO_CM = 50)
  return (Math.abs(dx) / refTorso) * ar * 50;
}

/**
 * body lean 변화량 → cm 변환
 */
function leanToCm(leanDelta, refTorso) {
  const cal = getCalibration();
  if (cal) {
    // lean은 x방향 변위이므로 horizontalCm 사용, 보정 계수 2.5 적용
    return horizontalCm(leanDelta) * 2.5;
  }
  return (leanDelta / refTorso) * 50 * 2.5;
}

// ── 메인 분석 ──

/**
 * 매 프레임 호출
 */
export function analyzeArmReach(landmarks) {
  if (!landmarks || landmarks.length < 33) return null;

  if (completed) {
    const activeIsLeft = initialState ? initialState.activeIsLeft : pickActiveArm(landmarks);
    const arm = getArmData(landmarks, activeIsLeft);
    return {
      isStanding: true,
      armRaised: false,
      shoulderAngle: Math.round(arm.shoulderAngle),
      elbowAngle: Math.round(arm.elbowAngle),
      currentReachCm: 0,
      maxReachCm: Math.round(maxReachCm * 10) / 10,
      feetMoved: false,
      feetEverMoved,
      wristPos: { x: arm.wrist.x, y: arm.wrist.y },
      isLeft: activeIsLeft,
      viewAngle: initialState ? initialState.viewAngle : detectViewAngle(landmarks)
    };
  }

  const lShoulder = landmarks[11], rShoulder = landmarks[12];
  const lHip = landmarks[23], rHip = landmarks[24];
  const lAnkle = landmarks[27], rAnkle = landmarks[28];

  // 서있음 판정
  const hipY = (lHip.y + rHip.y) / 2;
  const ankleY = (lAnkle.y + rAnkle.y) / 2;
  const shoulderY = (lShoulder.y + rShoulder.y) / 2;
  const hipToAnkleRatio = (ankleY - hipY) / (ankleY - shoulderY);
  const isStanding = hipToAnkleRatio > 0.45;

  const currentTorsoHeight = Math.abs(shoulderY - hipY);

  const viewAngle = initialState ? initialState.viewAngle : detectViewAngle(landmarks);
  const activeIsLeft = initialState ? initialState.activeIsLeft : pickActiveArm(landmarks);
  const arm = getArmData(landmarks, activeIsLeft);

  const armRaised = isArmRaisedCheck(arm, currentTorsoHeight);

  // 발 움직임 체크
  let feetMoved = false;
  if (initialState) {
    const lDist = Math.hypot(
      lAnkle.x - initialState.ankles.lx,
      lAnkle.y - initialState.ankles.ly
    );
    const rDist = Math.hypot(
      rAnkle.x - initialState.ankles.rx,
      rAnkle.y - initialState.ankles.ry
    );
    feetMoved = lDist > 0.05 || rDist > 0.05;
    if (feetMoved) feetEverMoved = true;
  }

  const shoulderMidX = (lShoulder.x + rShoulder.x) / 2;
  const hipMidX = (lHip.x + rHip.x) / 2;

  // ── 거리 계산 ──
  let currentReachCm = 0;
  if (initialState && initialState.torsoHeight > 0.01) {
    const refTorso = initialState.torsoHeight;
    const ar = initialState.aspectRatio || (16 / 9);

    if (viewAngle === 'side') {
      // 측면: 손목 x변위
      const dx = arm.wrist.x - initialState.wristX;
      currentReachCm = dxToCm(dx, refTorso, ar);
    } else {
      // 정면: body lean
      const currentLean = shoulderMidX - hipMidX;
      const initialLean = initialState.shoulderMidX - initialState.hipMidX;
      const leanDelta = Math.abs(currentLean - initialLean);
      currentReachCm = leanToCm(leanDelta, refTorso);

      // 손목 x변위도 체크
      const dxWrist = arm.wrist.x - initialState.wristX;
      const wristReachCm = dxToCm(dxWrist, refTorso, ar);
      currentReachCm = Math.max(currentReachCm, wristReachCm);
    }

    if (currentReachCm > maxReachCm) {
      maxReachCm = currentReachCm;
    }

    reachHistory.push({ reach: currentReachCm, time: Date.now() });
    if (reachHistory.length > 300) reachHistory.shift();
  }

  return {
    isStanding,
    armRaised,
    shoulderAngle: Math.round(arm.shoulderAngle),
    elbowAngle: Math.round(arm.elbowAngle),
    currentReachCm: Math.round(currentReachCm * 10) / 10,
    maxReachCm: Math.round(maxReachCm * 10) / 10,
    feetMoved,
    feetEverMoved,
    wristPos: { x: arm.wrist.x, y: arm.wrist.y },
    isLeft: activeIsLeft,
    viewAngle
  };
}

/**
 * 초기 위치 기록 (waiting → reaching 전환 시 호출)
 */
export function recordInitialPosition(landmarks, aspectRatio) {
  if (!landmarks || landmarks.length < 33) return false;

  const activeIsLeft = pickActiveArm(landmarks);
  const arm = getArmData(landmarks, activeIsLeft);
  const lAnkle = landmarks[27], rAnkle = landmarks[28];
  const lShoulder = landmarks[11], rShoulder = landmarks[12];
  const lHip = landmarks[23], rHip = landmarks[24];

  initialState = {
    wristX: arm.wrist.x,
    wristY: arm.wrist.y,
    shoulderMidX: (lShoulder.x + rShoulder.x) / 2,
    hipMidX: (lHip.x + rHip.x) / 2,
    torsoHeight: Math.abs((lShoulder.y + rShoulder.y) / 2 - (lHip.y + rHip.y) / 2),
    viewAngle: detectViewAngle(landmarks),
    aspectRatio: aspectRatio || (16 / 9),
    activeIsLeft,
    ankles: {
      lx: lAnkle.x, ly: lAnkle.y,
      rx: rAnkle.x, ry: rAnkle.y
    },
    timestamp: Date.now()
  };

  maxReachCm = 0;
  reachHistory = [];
  completed = false;
  feetEverMoved = false;
  return true;
}

/**
 * 뻗은 후 돌아오는지 판정 (자동 완료용)
 */
export function isReturningFromReach() {
  if (reachHistory.length < 30 || maxReachCm < 3) return false;
  const recent = reachHistory.slice(-10);
  const avgRecent = recent.reduce((s, r) => s + r.reach, 0) / recent.length;
  return avgRecent < maxReachCm * 0.3;
}

/**
 * 점수 계산
 */
export function calculateArmReachScore(maxReach, feetMoved, lostBalance) {
  if (lostBalance) {
    return { score: 0, reason: '균형을 잃어 외부 지지가 필요합니다' };
  }
  // BBS 원래 기준: 거리 기반 채점 (발 움직임은 4점에서만 감점)
  if (maxReach >= 25) {
    if (feetMoved) {
      return { score: 3, reason: `${maxReach.toFixed(1)}cm - 25cm 이상이나 발 움직임 감지` };
    }
    return { score: 4, reason: `${maxReach.toFixed(1)}cm - 자신 있게 뻗을 수 있음` };
  }
  if (maxReach >= 12.5) {
    return { score: 3, reason: `${maxReach.toFixed(1)}cm - 안전하게 뻗을 수 있음` };
  }
  if (maxReach >= 5) {
    return { score: 2, reason: `${maxReach.toFixed(1)}cm - 제한적으로 뻗을 수 있음` };
  }
  if (maxReach > 0) {
    return { score: 1, reason: `${maxReach.toFixed(1)}cm - 감독 필요` };
  }
  return { score: 0, reason: '팔 뻗기를 수행할 수 없음' };
}

/**
 * 리포트 생성
 */
export function generateArmReachReport(scoreResult, maxReach, feetMoved) {
  const cal = getCalibration();
  return {
    score: scoreResult.score,
    scoring: {
      autoScore: scoreResult.score,
      reason: scoreResult.reason
    },
    measurement: {
      maxReachCm: maxReach.toFixed(1),
      feetMoved,
      calibrated: !!cal,
      patientHeight: cal ? cal.heightCm : null,
    },
    testInfo: {
      item: '8. 팔 뻗어 앞으로 내밀기',
      method: cal ? 'AI 측정 (키 기반 캘리브레이션)' : 'AI 측정 (추정값)'
    }
  };
}
