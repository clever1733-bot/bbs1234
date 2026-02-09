/**
 * BBS 항목 10 - 뒤돌아보기 (Looking Behind Over Shoulders)
 *
 * 서 있는 자세에서 왼쪽/오른쪽 어깨 너머로 뒤돌아보기.
 *
 * 측정 원리:
 *  - 회전량: 어깨 폭(lShoulder.x − rShoulder.x) 비율 → acos로 각도 환산
 *  - 방향: z-depth 차이(primary) + 코-어깨 중심 오프셋(secondary)
 *  - 체중 이동: 엉덩이 중심 x 수평 변위
 *
 * 정면 촬영 권장 — 측면에서는 어깨 폭 변화가 작아 정확도 낮음.
 */

// ── 모듈 상태 ──
let initialState = null;
let leftMaxRotation = 0;   // 왼쪽 최대 회전 각도 (도)
let rightMaxRotation = 0;  // 오른쪽 최대 회전 각도 (도)
let leftWeightShift = 0;   // 왼쪽 회전 시 최대 체중 이동 (정규화)
let rightWeightShift = 0;  // 오른쪽 회전 시 최대 체중 이동 (정규화)
let completed = false;
let feetEverMoved = false;
let rotationHistory = [];   // [{ angle, direction, time }]

// ── 유틸 ──

/**
 * 촬영 방향 판정 (정면 vs 측면)
 */
function detectViewAngle(landmarks) {
  const lShoulder = landmarks[11], rShoulder = landmarks[12];
  const shoulderXGap = Math.abs(lShoulder.x - rShoulder.x);
  return shoulderXGap >= 0.12 ? 'front' : 'side';
}

// ── 공개 함수 ──

/**
 * 분석 상태 초기화
 */
export function resetLookBehindAnalysis() {
  initialState = null;
  leftMaxRotation = 0;
  rightMaxRotation = 0;
  leftWeightShift = 0;
  rightWeightShift = 0;
  completed = false;
  feetEverMoved = false;
  rotationHistory = [];
}

/**
 * 측정 완료 표시
 */
export function markLookBehindComplete() {
  completed = true;
}

/**
 * 초기 위치 기록 (waiting → measuring 전환 시 호출)
 */
export function recordLookBehindInitial(landmarks) {
  if (!landmarks || landmarks.length < 33) return false;

  const lShoulder = landmarks[11], rShoulder = landmarks[12];
  const lHip = landmarks[23], rHip = landmarks[24];
  const lAnkle = landmarks[27], rAnkle = landmarks[28];
  const nose = landmarks[0];

  const shoulderWidth = Math.abs(lShoulder.x - rShoulder.x);
  const shoulderMidX = (lShoulder.x + rShoulder.x) / 2;
  const hipMidX = (lHip.x + rHip.x) / 2;

  initialState = {
    shoulderWidth,
    shoulderMidX,
    hipMidX,
    noseX: nose.x,
    noseOffset: nose.x - shoulderMidX,
    shoulderZDiff: (lShoulder.z || 0) - (rShoulder.z || 0),
    torsoHeight: Math.abs((lShoulder.y + rShoulder.y) / 2 - (lHip.y + rHip.y) / 2),
    viewAngle: detectViewAngle(landmarks),
    ankles: {
      lx: lAnkle.x, ly: lAnkle.y,
      rx: rAnkle.x, ry: rAnkle.y
    },
    timestamp: Date.now()
  };

  leftMaxRotation = 0;
  rightMaxRotation = 0;
  leftWeightShift = 0;
  rightWeightShift = 0;
  completed = false;
  feetEverMoved = false;
  rotationHistory = [];
  return true;
}

/**
 * 매 프레임 호출 — 분석
 */
export function analyzeLookBehind(landmarks) {
  if (!landmarks || landmarks.length < 33) return null;

  const lShoulder = landmarks[11], rShoulder = landmarks[12];
  const lHip = landmarks[23], rHip = landmarks[24];
  const lAnkle = landmarks[27], rAnkle = landmarks[28];
  const nose = landmarks[0];

  const shoulderY = (lShoulder.y + rShoulder.y) / 2;
  const hipY = (lHip.y + rHip.y) / 2;
  const ankleY = (lAnkle.y + rAnkle.y) / 2;

  // 서있음 판정
  const denom = ankleY - shoulderY;
  const hipToAnkleRatio = denom > 0.001 ? (ankleY - hipY) / denom : 0;
  const isStanding = hipToAnkleRatio > 0.45;

  // 현재 어깨 폭
  const currentShoulderWidth = Math.abs(lShoulder.x - rShoulder.x);
  const shoulderMidX = (lShoulder.x + rShoulder.x) / 2;
  const hipMidX = (lHip.x + rHip.x) / 2;

  let rotationAngle = 0;
  let turnDirection = 'center';
  let weightShift = 0;
  let isAtCenter = true;
  const viewAngle = initialState ? initialState.viewAngle : detectViewAngle(landmarks);

  if (initialState && initialState.shoulderWidth > 0.02) {
    // ── 회전 각도: 어깨 폭 비율에서 추정 ──
    // cos(θ) = currentWidth / initialWidth  →  θ = acos(ratio)
    const widthRatio = Math.min(1, currentShoulderWidth / initialState.shoulderWidth);
    rotationAngle = Math.acos(Math.max(0, Math.min(1, widthRatio))) * (180 / Math.PI);

    // ── 방향 판별 ──
    // 노이즈 방지: 최소 8° 이상 회전 시에만 방향 판정
    if (rotationAngle > 8) {
      // (1) z-depth 방식 (primary): 왼쪽 어깨 z가 커지면(뒤로 감) 왼쪽 회전
      const currentZDiff = (lShoulder.z || 0) - (rShoulder.z || 0);
      const zDelta = currentZDiff - initialState.shoulderZDiff;

      // (2) 코 위치 방식 (secondary): 코가 어깨 중심 대비 이동한 방향
      const currentNoseOffset = nose.x - shoulderMidX;
      const noseDelta = currentNoseOffset - initialState.noseOffset;

      if (Math.abs(zDelta) > 0.03) {
        // z가 양수 변화 → left shoulder 뒤로 → 환자 왼쪽 회전
        turnDirection = zDelta > 0 ? 'left' : 'right';
      } else if (Math.abs(noseDelta) > 0.015) {
        // 코가 이미지 왼쪽 이동 → 환자 왼쪽 회전
        // (미러링 여부에 관계없이 양방향 구분에는 영향 없음)
        turnDirection = noseDelta < 0 ? 'left' : 'right';
      }
    }

    isAtCenter = rotationAngle < 10;

    // ── 체중 이동: 엉덩이 중심 수평 이동량 ──
    weightShift = Math.abs(hipMidX - initialState.hipMidX);

    // ── 최대 회전 업데이트 ──
    if (!completed) {
      if (turnDirection === 'left' && rotationAngle > leftMaxRotation) {
        leftMaxRotation = rotationAngle;
        leftWeightShift = Math.max(leftWeightShift, weightShift);
      }
      if (turnDirection === 'right' && rotationAngle > rightMaxRotation) {
        rightMaxRotation = rotationAngle;
        rightWeightShift = Math.max(rightWeightShift, weightShift);
      }

      rotationHistory.push({ angle: rotationAngle, direction: turnDirection, time: Date.now() });
      if (rotationHistory.length > 300) rotationHistory.shift();
    }
  }

  // ── 발 움직임 체크 ──
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

  return {
    isStanding,
    rotationAngle: Math.round(rotationAngle),
    turnDirection,
    leftMaxRotation: Math.round(leftMaxRotation),
    rightMaxRotation: Math.round(rightMaxRotation),
    weightShift: Math.round(weightShift * 1000) / 1000,
    leftWeightShift: Math.round(leftWeightShift * 1000) / 1000,
    rightWeightShift: Math.round(rightWeightShift * 1000) / 1000,
    isAtCenter,
    feetMoved,
    feetEverMoved,
    viewAngle
  };
}

/**
 * 양방향 회전 완료 판정
 *
 * 조건:
 *  1. 양쪽 모두 MIN_ROTATION 이상 회전 기록됨
 *  2. 충분한 프레임 수집 (30+)
 *  3. 최근 10프레임 평균 회전이 15° 미만 (중앙 복귀)
 */
export function isLookBehindComplete() {
  const MIN_ROTATION = 20;
  if (leftMaxRotation < MIN_ROTATION || rightMaxRotation < MIN_ROTATION) return false;
  if (rotationHistory.length < 30) return false;

  const recent = rotationHistory.slice(-10);
  const avgAngle = recent.reduce((s, r) => s + r.angle, 0) / recent.length;
  return avgAngle < 15;
}

/**
 * 점수 계산
 *
 * - 4점: 양쪽 뒤돌아보기 우수(45°+) + 체중 이동 좋음 + 발 고정
 * - 3점: 한쪽 우수, 다른 쪽 보통(30°+)
 * - 2점: 옆으로만 돌아볼 수 있지만(30°+ 한쪽) 균형 유지
 * - 1점: 회전 범위 부족, 감독 필요
 * - 0점: 수행 불가 / 균형 상실
 */
export function calculateLookBehindScore(leftRot, rightRot, leftWS, rightWS, feetMoved, lostBalance) {
  if (lostBalance) {
    return { score: 0, reason: '균형을 잃어 도움이 필요합니다' };
  }

  const GOOD_ROTATION = 45;     // 우수 기준 (도)
  const MODERATE_ROTATION = 30; // 보통 기준 (도)
  const GOOD_WEIGHT_SHIFT = 0.02; // 체중 이동 기준 (정규화)

  const leftGood = leftRot >= GOOD_ROTATION;
  const rightGood = rightRot >= GOOD_ROTATION;
  const leftModerate = leftRot >= MODERATE_ROTATION;
  const rightModerate = rightRot >= MODERATE_ROTATION;
  const hasWeightShift = leftWS >= GOOD_WEIGHT_SHIFT || rightWS >= GOOD_WEIGHT_SHIFT;

  // 4점: 양쪽 우수 + 체중 이동 + 발 고정
  if (leftGood && rightGood && hasWeightShift && !feetMoved) {
    return { score: 4, reason: `양쪽 뒤돌아보기 우수 (좌 ${leftRot}° / 우 ${rightRot}°)` };
  }

  // 3점: 한쪽 우수 + 양쪽 보통 이상
  if ((leftGood || rightGood) && (leftModerate && rightModerate)) {
    return { score: 3, reason: `한쪽 우수, 다른 쪽 보통 (좌 ${leftRot}° / 우 ${rightRot}°)` };
  }

  // 2점: 한쪽이라도 보통 이상 + 균형 유지
  if (leftModerate || rightModerate) {
    return { score: 2, reason: `제한적 회전, 균형 유지 (좌 ${leftRot}° / 우 ${rightRot}°)` };
  }

  // 1점: 약간의 회전 시도
  if (leftRot > 10 || rightRot > 10) {
    return { score: 1, reason: `회전 범위 부족 (좌 ${leftRot}° / 우 ${rightRot}°) — 감독 필요` };
  }

  // 0점: 수행 불가
  return { score: 0, reason: '뒤돌아보기를 수행할 수 없음' };
}

/**
 * 리포트 생성
 */
export function generateLookBehindReport(scoreResult, leftRot, rightRot, leftWS, rightWS, feetMoved) {
  return {
    score: scoreResult.score,
    scoring: {
      autoScore: scoreResult.score,
      reason: scoreResult.reason
    },
    measurement: {
      leftRotation: leftRot,
      rightRotation: rightRot,
      leftWeightShift: leftWS,
      rightWeightShift: rightWS,
      feetMoved
    },
    testInfo: {
      item: '10. 뒤돌아보기',
      method: 'AI 자동 측정'
    }
  };
}
