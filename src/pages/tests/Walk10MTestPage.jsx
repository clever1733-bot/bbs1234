import { useState, useRef, useEffect, useCallback } from 'react';
import { PageContainer, Header } from '../../components/layout';
import { Button, Card, Alert, ProgressBar } from '../../components/ui';
import { PatientInfoForm, DualVideoUpload } from '../../components/forms';
import { drawConnections, drawLandmarks } from '../../utils/poseDrawing';
import { calibrate, resetCalibration } from '../../utils/bodyCalibration';
import { calculate10MRisk, getRiskColorClasses } from '../../utils/riskCalculation';
import { useNavigation, PAGES } from '../../context/NavigationContext';
import { useTestHistory } from '../../context/TestHistoryContext';

function Walk10MTestPage() {
  const [step, setStep] = useState('setup'); // setup, ready, measuring, complete
  const [timer, setTimer] = useState(0);
  const [patientInfo, setPatientInfo] = useState({ name: '홍길동', id: 'P-DEMO-001', height: '' });
  const [results, setResults] = useState(null);
  const [distance] = useState(10);

  // 측면 영상
  const [sideFile, setSideFile] = useState(null);
  const [sideUrl, setSideUrl] = useState(null);
  // 정면 영상
  const [frontFile, setFrontFile] = useState(null);
  const [frontUrl, setFrontUrl] = useState(null);
  // 분석에 사용할 영상 (측면 우선)
  const [activeVideoUrl, setActiveVideoUrl] = useState(null);

  // 입력 모드: 'upload' | 'camera'
  const [inputMode, setInputMode] = useState('upload');

  const [isAnalyzing, setIsAnalyzing] = useState(false); // eslint-disable-line no-unused-vars
  const [analysisProgress, setAnalysisProgress] = useState(0);

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const timerRef = useRef(null);
  const poseRef = useRef(null);
  const animationRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const calibratedRef = useRef(false);
  const patientHeightRef = useRef('');

  const { navigateTo } = useNavigation();
  const { addTestResult } = useTestHistory();

  const hasAnyVideo = sideFile || frontFile;

  // 파일 선택 핸들러
  const handleSideSelect = (file) => {
    setSideFile(file);
    setSideUrl(URL.createObjectURL(file));
  };
  const handleSideRemove = () => {
    if (sideUrl) URL.revokeObjectURL(sideUrl);
    setSideFile(null);
    setSideUrl(null);
  };
  const handleFrontSelect = (file) => {
    setFrontFile(file);
    setFrontUrl(URL.createObjectURL(file));
  };
  const handleFrontRemove = () => {
    if (frontUrl) URL.revokeObjectURL(frontUrl);
    setFrontFile(null);
    setFrontUrl(null);
  };

  const handleReady = () => {
    patientHeightRef.current = patientInfo.height;
    if (inputMode === 'upload') {
      setActiveVideoUrl(sideUrl || frontUrl);
    }
    setStep('ready');
  };

  const handleVideoLoaded = () => {
    if (videoRef.current && canvasRef.current) {
      canvasRef.current.width = videoRef.current.videoWidth;
      canvasRef.current.height = videoRef.current.videoHeight;
    }
  };

  // MediaPipe 초기화
  const initPose = useCallback(async () => {
    try {
      const { Pose } = await import('@mediapipe/pose');

      const pose = new Pose({
        locateFile: (file) => {
          return `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`;
        }
      });

      pose.setOptions({
        modelComplexity: 1,
        smoothLandmarks: true,
        enableSegmentation: false,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
      });

      pose.onResults((results) => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        ctx.save();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(results.image, 0, 0, canvas.width, canvas.height);

        if (results.poseLandmarks) {
          // 첫 프레임에서 캘리브레이션 수행
          if (!calibratedRef.current && patientHeightRef.current) {
            const ar = canvas.width / canvas.height;
            calibrate(patientHeightRef.current, results.poseLandmarks, ar);
            calibratedRef.current = true;
          }

          drawConnections(ctx, results.poseLandmarks, canvas.width, canvas.height);
          drawLandmarks(ctx, results.poseLandmarks, canvas.width, canvas.height);
        }

        ctx.restore();
      });

      poseRef.current = pose;
      return pose;
    } catch (error) {
      console.error('Pose init error:', error);
      return null;
    }
  }, []);

  // 카메라 스트림 정리
  const stopCamera = () => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(t => t.stop());
      mediaStreamRef.current = null;
    }
  };

  // 영상 분석 시작
  const startAnalysis = async () => {
    if (!videoRef.current || !canvasRef.current) return;

    setIsAnalyzing(true);
    setStep('measuring');
    setTimer(0);

    const pose = await initPose();
    if (!pose) {
      alert('포즈 감지 초기화에 실패했습니다.');
      setIsAnalyzing(false);
      return;
    }

    const startTime = Date.now();
    timerRef.current = setInterval(() => {
      const elapsed = (Date.now() - startTime) / 1000;
      setTimer(elapsed);
    }, 100);

    // 실시간 카메라 모드
    if (inputMode === 'camera') {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } }
      });
      mediaStreamRef.current = stream;
      videoRef.current.srcObject = stream;
      videoRef.current.muted = true;
      videoRef.current.playsInline = true;

      await new Promise(resolve => { videoRef.current.onloadedmetadata = resolve; });
      canvasRef.current.width = videoRef.current.videoWidth;
      canvasRef.current.height = videoRef.current.videoHeight;
      await videoRef.current.play();

      const processFrame = async () => {
        if (poseRef.current && videoRef.current && videoRef.current.readyState >= 2) {
          try { await poseRef.current.send({ image: videoRef.current }); } catch { /* ignore */ }
        }
        animationRef.current = requestAnimationFrame(processFrame);
      };
      animationRef.current = requestAnimationFrame(processFrame);
      return;
    }

    // 영상 업로드 모드
    videoRef.current.currentTime = 0;
    videoRef.current.play();

    const analyzeFrame = async () => {
      if (!videoRef.current || videoRef.current.paused || videoRef.current.ended) {
        return;
      }

      try {
        await pose.send({ image: videoRef.current });
      } catch (e) {
        console.error('Frame analysis error:', e);
      }

      const progress = (videoRef.current.currentTime / videoRef.current.duration) * 100;
      setAnalysisProgress(progress);

      animationRef.current = requestAnimationFrame(analyzeFrame);
    };

    analyzeFrame();
  };

  const handleVideoEnded = () => {
    if (step === 'measuring') {
      stopMeasurement();
    }
  };

  const stopMeasurement = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    stopCamera();
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }

    setIsAnalyzing(false);

    const totalTime = timer.toFixed(2);
    const speed = (distance / parseFloat(totalTime)).toFixed(2);
    const risk = calculate10MRisk(parseFloat(speed));

    const resultData = {
      id: Date.now(),
      type: '10M',
      patient: patientInfo.name || '미입력',
      patientId: patientInfo.id || '-',
      date: new Date().toLocaleDateString(),
      time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }),
      result: `${speed}m/s`,
      risk: risk.label,
      details: {
        totalTime,
        speed,
        distance,
        sideVideo: sideFile?.name || '없음',
        frontVideo: frontFile?.name || '없음',
      }
    };

    addTestResult(resultData);
    setResults({ totalTime, speed, risk });
    setStep('complete');
  };

  const resetMeasurement = () => {
    setStep('setup');
    setTimer(0);
    setResults(null);
    setPatientInfo({ name: '홍길동', id: 'P-DEMO-001', height: '' });
    stopCamera();
    handleSideRemove();
    handleFrontRemove();
    setActiveVideoUrl(null);
    setAnalysisProgress(0);
    setInputMode('upload');
    calibratedRef.current = false;
    resetCalibration();
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach(t => t.stop());
        mediaStreamRef.current = null;
      }
      if (sideUrl) URL.revokeObjectURL(sideUrl);
      if (frontUrl) URL.revokeObjectURL(frontUrl);
    };
  }, [sideUrl, frontUrl]);

  return (
    <PageContainer>
      <Header
        title="10M 보행검사"
        onBack={() => navigateTo(PAGES.HOME)}
      />

      <main className="max-w-4xl mx-auto px-4 py-8">
        {/* Setup 단계 */}
        {step === 'setup' && (
          <div className="space-y-6">
            <Card padding="md">
              <h3 className="text-white font-semibold mb-4">10미터 보행검사 안내</h3>
              <div className="text-slate-400 text-sm space-y-2">
                <p>1. 총 14미터 구간을 설정합니다 (가속 2m + 측정 10m + 감속 2m)</p>
                <p>2. 환자가 시작선에서 출발합니다</p>
                <p>3. 10미터 측정 구간의 시작점에서 타이머를 시작합니다</p>
                <p>4. 측정 구간 종료점에서 타이머를 멈춥니다</p>
              </div>

              <div className="mt-4 p-4 bg-slate-800/50 rounded-xl">
                <div className="flex items-center justify-between text-xs text-slate-500 mb-2">
                  <span>시작</span>
                  <span>측정 시작</span>
                  <span>측정 종료</span>
                  <span>끝</span>
                </div>
                <div className="flex h-4 rounded-full overflow-hidden">
                  <div className="w-[14%] bg-purple-500/30" />
                  <div className="w-[72%] bg-purple-500" />
                  <div className="w-[14%] bg-purple-500/30" />
                </div>
                <div className="flex items-center justify-between text-xs text-slate-400 mt-2">
                  <span>2m</span>
                  <span>10m</span>
                  <span>2m</span>
                </div>
              </div>

              <Alert type="info" className="mt-4">
                <strong>판정 기준:</strong> 1.0m/s 이상(정상), 0.8-1.0m/s(경도 장애), 0.8m/s 미만(기능적 제한)
              </Alert>
            </Card>

            <Card padding="md">
              <h3 className="text-white font-semibold mb-4">환자 정보</h3>
              <PatientInfoForm
                patientInfo={patientInfo}
                onChange={setPatientInfo}
                accentColor="purple"
              />
            </Card>

            <Card padding="md">
              <h3 className="text-white font-semibold mb-4">입력 방식</h3>
              <div className="flex rounded-lg overflow-hidden border border-slate-600">
                <button
                  className={`flex-1 py-3 text-sm font-medium transition-colors ${
                    inputMode === 'upload'
                      ? 'bg-purple-500 text-white'
                      : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                  }`}
                  onClick={() => setInputMode('upload')}
                >
                  영상 업로드
                </button>
                <button
                  className={`flex-1 py-3 text-sm font-medium transition-colors ${
                    inputMode === 'camera'
                      ? 'bg-purple-500 text-white'
                      : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                  }`}
                  onClick={() => setInputMode('camera')}
                >
                  실시간 카메라
                </button>
              </div>
            </Card>

            {inputMode === 'upload' ? (
              <DualVideoUpload
                sideFile={sideFile}
                sideUrl={sideUrl}
                onSideSelect={handleSideSelect}
                onSideRemove={handleSideRemove}
                frontFile={frontFile}
                frontUrl={frontUrl}
                onFrontSelect={handleFrontSelect}
                onFrontRemove={handleFrontRemove}
                accentColor="purple"
              />
            ) : (
              <Card padding="md">
                <div className="text-center py-6 space-y-3">
                  <div className="w-16 h-16 mx-auto bg-purple-500/20 rounded-full flex items-center justify-center">
                    <svg className="w-8 h-8 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                  </div>
                  <p className="text-white font-medium">후면 카메라를 사용합니다</p>
                  <p className="text-slate-400 text-sm">검사 시작 시 카메라 권한을 요청합니다.<br/>전신이 보이도록 기기를 배치해주세요.</p>
                </div>
              </Card>
            )}

            <Button
              variant="walk10m"
              size="lg"
              fullWidth
              onClick={handleReady}
              disabled={inputMode === 'upload' && !hasAnyVideo}
            >
              {inputMode === 'camera' ? '분석 준비' : (hasAnyVideo ? '분석 준비' : '영상을 먼저 선택하세요')}
            </Button>
          </div>
        )}

        {/* Ready 단계 */}
        {step === 'ready' && (
          <div className="space-y-6">
            <Card padding="md">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 bg-purple-500/20 rounded-lg flex items-center justify-center">
                  <svg className="w-5 h-5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-white font-semibold">분석 준비 완료</h3>
                  <p className="text-slate-400 text-sm">
                    {inputMode === 'camera' ? '실시간 카메라 모드' : (
                      <>
                        {sideFile && `측면: ${sideFile.name}`}
                        {sideFile && frontFile && ' / '}
                        {frontFile && `정면: ${frontFile.name}`}
                      </>
                    )}
                  </p>
                </div>
              </div>

              <div className="aspect-video bg-slate-800 rounded-xl overflow-hidden relative">
                <video
                  ref={videoRef}
                  src={inputMode === 'upload' ? activeVideoUrl : undefined}
                  className="w-full h-full object-contain"
                  onLoadedMetadata={handleVideoLoaded}
                  onEnded={handleVideoEnded}
                />
                <canvas
                  ref={canvasRef}
                  className="absolute inset-0 w-full h-full object-contain pointer-events-none"
                  style={{ display: 'none' }}
                />
              </div>

              <Alert type="warning" className="mt-4">
                {inputMode === 'camera'
                  ? '"분석 시작" 버튼을 누르면 카메라가 켜지며 AI가 실시간으로 보행을 분석합니다.'
                  : '"분석 시작" 버튼을 누르면 영상이 재생되면서 AI가 보행을 분석합니다. 영상이 끝나면 자동으로 측정이 완료됩니다.'}
              </Alert>
            </Card>

            <div className="flex gap-4">
              <Button
                variant="secondary"
                size="lg"
                className="flex-1"
                onClick={() => setStep('setup')}
              >
                이전
              </Button>
              <Button
                variant="walk10m"
                size="lg"
                className="flex-1"
                onClick={startAnalysis}
                leftIcon={
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                }
              >
                분석 시작
              </Button>
            </div>
          </div>
        )}

        {/* Measuring 단계 */}
        {step === 'measuring' && (
          <div className="space-y-6">
            <div className="aspect-video bg-slate-800 rounded-2xl overflow-hidden relative">
              <video
                ref={videoRef}
                src={inputMode === 'upload' ? activeVideoUrl : undefined}
                className="absolute inset-0 w-full h-full object-contain"
                onEnded={handleVideoEnded}
                muted
              />
              <canvas
                ref={canvasRef}
                className="absolute inset-0 w-full h-full object-contain"
              />

              <div className="absolute top-4 left-4 bg-slate-900/80 px-4 py-2 rounded-full">
                <span className="text-white font-mono text-2xl">{timer.toFixed(1)}초</span>
              </div>

              <div className="absolute top-4 right-4 flex items-center gap-2 bg-red-500/20 px-3 py-1 rounded-full">
                <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                <span className="text-red-400 text-sm">분석 중</span>
              </div>
            </div>

            <ProgressBar
              progress={analysisProgress}
              color="purple"
              height="md"
              showLabel
            />

            <Button
              variant="danger"
              size="xl"
              fullWidth
              onClick={stopMeasurement}
            >
              STOP - 분석 완료
            </Button>
          </div>
        )}

        {/* Complete 단계 */}
        {step === 'complete' && results && (
          <div className="text-center space-y-6">
            <div className="w-20 h-20 bg-purple-500/20 rounded-full flex items-center justify-center mx-auto">
              <svg className="w-10 h-10 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>

            <h2 className="text-2xl font-bold text-white">10M 보행검사 완료</h2>

            <Card padding="md" className="max-w-md mx-auto">
              <div className="grid grid-cols-2 gap-4 mb-6">
                <div className="text-center">
                  <p className="text-slate-400 text-sm mb-1">소요 시간</p>
                  <p className="text-3xl font-bold text-white">{results.totalTime}초</p>
                </div>
                <div className="text-center">
                  <p className="text-slate-400 text-sm mb-1">보행 속도</p>
                  <p className="text-3xl font-bold text-white">{results.speed}m/s</p>
                </div>
              </div>

              <div className={`p-4 rounded-xl ${getRiskColorClasses(results.risk.level).bg} border ${getRiskColorClasses(results.risk.level).border}`}>
                <p className={`font-semibold ${getRiskColorClasses(results.risk.level).text}`}>
                  기능 수준: {results.risk.label}
                </p>
                <p className={`text-sm mt-1 opacity-70 ${getRiskColorClasses(results.risk.level).text}`}>
                  {results.risk.level === 'low' && '정상 보행 속도입니다.'}
                  {results.risk.level === 'medium' && '경도의 보행 장애가 있습니다.'}
                  {results.risk.level === 'high' && '기능적 보행 제한이 있습니다.'}
                </p>
              </div>
            </Card>

            <div className="flex gap-4 justify-center">
              <Button
                variant="secondary"
                onClick={() => navigateTo(PAGES.HOME)}
              >
                홈으로
              </Button>
              <Button
                variant="walk10m"
                onClick={resetMeasurement}
              >
                다시 측정
              </Button>
            </div>
          </div>
        )}
      </main>
    </PageContainer>
  );
}

export default Walk10MTestPage;
