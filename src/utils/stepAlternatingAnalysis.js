/**
 * BBS 항목 12 - 발판에 발 교대로 올리기 (Placing Alternate Foot on Step/Stool)
 *
 * 서 있는 자세에서 발판(계단)에 양발을 번갈아가며 올렸다 내리는 동작 수행.
 *
 * 측정 원리 — 발목 Y좌표 기반 스텝 감지:
 *   좌/우 발목(landmark 27, 28)의 Y좌표를 추적.
 *   정규화 좌표에서 Y 감소 = 발 올라감.
 *   초기 Y 대비 bodyHeight × 0.06 이상 감소 → step up.
 *   다시 초기 높이 근처로 복귀 → step down → 1회 터치.
 *   교대 여부 별도 추적.
 */

// ── 모듈 상태 ──
let initialState = null;
let stepCount = 0;
let lastStepFoot = null;      // 'left' | 'right'
let alternatingCount = 0;
let isLeftUp = false;
let isRightUp = false;
let startTime = null;
let completed = false;
let feetEverMoved = false;

// step 전이 추적 (디바운스용)
let leftUpSince = null;
let rightUpSince = null;
let leftDownSince = null;
let rightDownSince = null;

// ── 설정 (관대하게) ──
const CONFIG = {
  STEP_UP_RATIO: 0.06,        // bodyHeight × 0.06 이상 Y 감소 → 발 올림 (~10cm)
  STEP_DOWN_RATIO: 0.03,      // bodyHeight × 0.03 이내 → 원래 높이 복귀
  DEBOUNCE_MS: 100,           // 전이 확인 디바운스 (빠른 반응)
  FEET_MOVE_THRESHOLD: 0.12,  // 발 수평 이동 감지
  MAX_TOUCH_COUNT: 8,         // 자동 완료 기준
  MAX_TIME_SEC: 20,           // 최대 측정 시간
};

// ── 유틸 ──

function getBodyHeight(landmarks) {
  const lShoulder = landmarks[11], rShoulder = landmarks[12];
  const lAnkle = landmarks[27], rAnkle = landmarks[28];
  const shoulderY = (lShoulder.y + rShoulder.y) / 2;
  const ankleY = (lAnkle.y + rAnkle.y) / 2;
  return Math.abs(ankleY - shoulderY);
}

function isStandingCheck(landmarks) {
  const lShoulder = landmarks[11], rShoulder = landmarks[12];
  const lHip = landmarks[23], rHip = landmarks[24];
  const lAnkle = landmarks[27], rAnkle = landmarks[28];
  const shoulderY = (lShoulder.y + rShoulder.y) / 2;
  const hipY = (lHip.y + rHip.y) / 2;
  const ankleY = (lAnkle.y + rAnkle.y) / 2;
  const denom = ankleY - shoulderY;
  const hipToAnkleRatio = denom > 0.001 ? (ankleY - hipY) / denom : 0;
  return hipToAnkleRatio > 0.45;
}

// ── 공개 함수 ──

export function resetStepAlternatingAnalysis() {
  initialState = null;
  stepCount = 0;
  lastStepFoot = null;
  alternatingCount = 0;
  isLeftUp = false;
  isRightUp = false;
  startTime = null;
  completed = false;
  feetEverMoved = false;
  leftUpSince = null;
  rightUpSince = null;
  leftDownSince = null;
  rightDownSince = null;
}

export function recordStepAlternatingInitial(landmarks) {
  if (!landmarks || landmarks.length < 33) return false;

  const lAnkle = landmarks[27], rAnkle = landmarks[28];
  const bodyHeight = getBodyHeight(landmarks);

  initialState = {
    ankleY_L: lAnkle.y,
    ankleY_R: rAnkle.y,
    ankleX_L: lAnkle.x,
    ankleX_R: rAnkle.x,
    bodyHeight,
    timestamp: Date.now()
  };

  stepCount = 0;
  lastStepFoot = null;
  alternatingCount = 0;
  isLeftUp = false;
  isRightUp = false;
  startTime = null;
  completed = false;
  feetEverMoved = false;
  leftUpSince = null;
  rightUpSince = null;
  leftDownSince = null;
  rightDownSince = null;

  return true;
}

/**
 * 매 프레임 분석
 */
export function analyzeStepAlternating(landmarks) {
  if (!initialState) return null;
  if (!landmarks || landmarks.length < 33) return null;

  const now = Date.now();
  const isStanding = isStandingCheck(landmarks);

  const lAnkle = landmarks[27], rAnkle = landmarks[28];

  // 시작 시간 기록 (첫 프레임에서)
  if (!startTime) {
    startTime = now;
  }

  const elapsedSec = Math.round((now - startTime) / 100) / 10;

  // 발 수평 이동 감지 (원래 위치 기준)
  const lHorizDist = Math.abs(lAnkle.x - initialState.ankleX_L);
  const rHorizDist = Math.abs(rAnkle.x - initialState.ankleX_R);
  const feetMoved = lHorizDist > CONFIG.FEET_MOVE_THRESHOLD || rHorizDist > CONFIG.FEET_MOVE_THRESHOLD;
  if (feetMoved) feetEverMoved = true;

  // Y 변화량 (정규화 좌표: Y 감소 = 위로 올라감)
  const bodyH = initialState.bodyHeight;
  const upThreshold = bodyH * CONFIG.STEP_UP_RATIO;
  const downThreshold = bodyH * CONFIG.STEP_DOWN_RATIO;

  const leftYDelta = initialState.ankleY_L - lAnkle.y;   // 양수 = 올라감
  const rightYDelta = initialState.ankleY_R - rAnkle.y;

  const leftShouldBeUp = leftYDelta > upThreshold;
  const rightShouldBeUp = rightYDelta > upThreshold;
  const leftShouldBeDown = leftYDelta < downThreshold;
  const rightShouldBeDown = rightYDelta < downThreshold;

  // ── 왼발 전이 처리 ──
  if (leftShouldBeUp && !isLeftUp) {
    if (!leftUpSince) {
      leftUpSince = now;
    } else if (now - leftUpSince >= CONFIG.DEBOUNCE_MS) {
      isLeftUp = true;
      leftUpSince = null;
      leftDownSince = null;
    }
  } else if (!leftShouldBeUp) {
    leftUpSince = null;
  }

  if (leftShouldBeDown && isLeftUp) {
    if (!leftDownSince) {
      leftDownSince = now;
    } else if (now - leftDownSince >= CONFIG.DEBOUNCE_MS) {
      // 왼발 내림 완료 → 1 터치
      isLeftUp = false;
      leftDownSince = null;
      leftUpSince = null;
      stepCount++;

      if (lastStepFoot === 'right') {
        alternatingCount++;
      }
      lastStepFoot = 'left';
    }
  } else if (!leftShouldBeDown) {
    leftDownSince = null;
  }

  // ── 오른발 전이 처리 ──
  if (rightShouldBeUp && !isRightUp) {
    if (!rightUpSince) {
      rightUpSince = now;
    } else if (now - rightUpSince >= CONFIG.DEBOUNCE_MS) {
      isRightUp = true;
      rightUpSince = null;
      rightDownSince = null;
    }
  } else if (!rightShouldBeUp) {
    rightUpSince = null;
  }

  if (rightShouldBeDown && isRightUp) {
    if (!rightDownSince) {
      rightDownSince = now;
    } else if (now - rightDownSince >= CONFIG.DEBOUNCE_MS) {
      // 오른발 내림 완료 → 1 터치
      isRightUp = false;
      rightDownSince = null;
      rightUpSince = null;
      stepCount++;

      if (lastStepFoot === 'left') {
        alternatingCount++;
      }
      lastStepFoot = 'right';
    }
  } else if (!rightShouldBeDown) {
    rightDownSince = null;
  }

  return {
    isStanding,
    stepCount,
    alternatingCount,
    lastStepFoot,
    isLeftUp,
    isRightUp,
    elapsedSec,
    feetMoved,
    feetEverMoved
  };
}

export function isStepAlternatingComplete() {
  return completed;
}

export function markStepAlternatingComplete() {
  completed = true;
}

/**
 * 점수 계산
 *
 * - 4점: 8회 이상 터치, 20초 이내 — 독립적으로 안전하게 완수
 * - 3점: 8회 이상 터치, 20초 초과 — 완수했지만 느림
 * - 2점: 4회 이상 터치 — 감독하에 4회 완수
 * - 1점: 2회 이상 터치 — 최소한의 도움으로 2회 이상
 * - 0점: 2회 미만 또는 균형 상실
 */
export function calculateStepAlternatingScore(touchCount, altCount, elapsedSec, lostBalance) {
  if (lostBalance || touchCount < 2) {
    return { score: 0, reason: `터치 ${touchCount}회 — 도움 필요 또는 안전 불가` };
  }

  // 터치 횟수 + 시간만으로 판정 — 방법 불문
  if (touchCount >= 8 && elapsedSec <= 20) {
    return { score: 4, reason: `${touchCount}회 터치, ${elapsedSec}초 — 독립적으로 안전하게 완수` };
  }

  if (touchCount >= 8) {
    return { score: 3, reason: `${touchCount}회 터치, ${elapsedSec}초 — 완수했지만 느림` };
  }

  if (touchCount >= 4) {
    return { score: 2, reason: `${touchCount}회 터치 — 감독하에 완수` };
  }

  return { score: 1, reason: `${touchCount}회 터치 — 최소한의 도움으로 완수` };
}

export function generateStepAlternatingReport(scoreResult, touchCount, altCount, elapsedSec) {
  return {
    score: scoreResult.score,
    scoring: {
      autoScore: scoreResult.score,
      reason: scoreResult.reason
    },
    measurement: {
      totalTouches: touchCount,
      alternatingTouches: altCount,
      elapsedSec,
    },
    testInfo: {
      item: '12. 발판에 발 교대로 올리기',
      method: 'AI 자동 측정'
    }
  };
}
