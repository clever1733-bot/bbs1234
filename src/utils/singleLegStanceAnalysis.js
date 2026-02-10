/**
 * BBS 항목 14 - 한 발로 서기 (Standing on One Leg)
 *
 * 지지 없이 한 발로 최대한 오래 서 있기 (최대 10초).
 *
 * 측정 원리 — 발목 Y좌표 차이 기반 한 발 들기 감지:
 *   좌/우 발목(27, 28)의 Y좌표 차이를 추적.
 *   한쪽 발목이 다른쪽보다 bodyHeight × 0.025 이상 높으면 "한 발 들기" 판정.
 *   0.6초 유예(grace period)로 일시적 노이즈에 의한 끊김 방지.
 *   유지 시간 추적, 10초 달성 시 자동 완료.
 */

// ── 모듈 상태 ──
let initialState = null;
let liftedFoot = null;           // 'left' | 'right' | null
let liftStartTime = null;        // 들기 시작 시각
let liftDuration = 0;            // 현재 유지 시간(초)
let maxDuration = 0;             // 최대 유지 시간
let bestLiftedFoot = null;       // 최대 유지 시 어느 발
let completed = false;
let liftConfirmedAt = null;      // 디바운스
let dropStartedAt = null;        // 발 내림 유예 시작 시각

// ── 설정 (관대하게) ──
const CONFIG = {
  LIFT_Y_RATIO: 0.025,           // bodyHeight × 0.025 이상 Y 차이 → 한 발 들기 (~4cm, 관대)
  LIFT_CONFIRM_MS: 150,          // 들기 확인 디바운스 (0.15초)
  DROP_GRACE_MS: 600,            // 발 내림 유예 시간 (0.6초) — 노이즈로 인한 끊김 방지
  TARGET_DURATION: 10,           // 목표: 10초
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

export function resetSingleLegStanceAnalysis() {
  initialState = null;
  liftedFoot = null;
  liftStartTime = null;
  liftDuration = 0;
  maxDuration = 0;
  bestLiftedFoot = null;
  completed = false;
  liftConfirmedAt = null;
  dropStartedAt = null;
}

export function recordSingleLegStanceInitial(landmarks) {
  if (!landmarks || landmarks.length < 33) return false;

  initialState = {
    bodyHeight: getBodyHeight(landmarks),
    ankleY_L: landmarks[27].y,
    ankleY_R: landmarks[28].y,
    timestamp: Date.now()
  };

  liftedFoot = null;
  liftStartTime = null;
  liftDuration = 0;
  maxDuration = 0;
  bestLiftedFoot = null;
  completed = false;
  liftConfirmedAt = null;
  dropStartedAt = null;

  return true;
}

/**
 * 매 프레임 분석
 */
export function analyzeSingleLegStance(landmarks) {
  if (!initialState) return null;
  if (!landmarks || landmarks.length < 33) return null;

  const now = Date.now();
  const isStanding = isStandingCheck(landmarks);

  const lAnkle = landmarks[27], rAnkle = landmarks[28];
  const bodyH = initialState.bodyHeight;
  const liftThreshold = bodyH * CONFIG.LIFT_Y_RATIO;

  // Y 차이 (정규화 좌표: Y 작을수록 위)
  const yDiff = lAnkle.y - rAnkle.y;
  // yDiff > 0 → 왼발이 아래, 오른발이 위 → 오른발 들림
  // yDiff < 0 → 오른발이 아래, 왼발이 위 → 왼발 들림

  let detectedLift = null;
  if (Math.abs(yDiff) > liftThreshold && isStanding) {
    detectedLift = yDiff > 0 ? 'right' : 'left';
  }

  // 전이 처리 (디바운스 + grace period)
  if (detectedLift) {
    // 발 들기 감지됨 — drop 유예 초기화
    dropStartedAt = null;

    if (liftedFoot === null) {
      // 새로운 들기 시작
      if (!liftConfirmedAt) {
        liftConfirmedAt = now;
      } else if (now - liftConfirmedAt >= CONFIG.LIFT_CONFIRM_MS) {
        liftedFoot = detectedLift;
        liftStartTime = now;
        liftConfirmedAt = null;
      }
    } else if (detectedLift === liftedFoot) {
      // 같은 발 유지 중
      liftConfirmedAt = null;
    } else {
      // 다른 발로 전환 — 이전 기록 저장 후 전환
      if (liftStartTime) {
        const elapsed = (now - liftStartTime) / 1000;
        if (elapsed > maxDuration) {
          maxDuration = Math.round(elapsed * 10) / 10;
          bestLiftedFoot = liftedFoot;
        }
      }
      liftedFoot = detectedLift;
      liftStartTime = now;
    }
  } else {
    // 발 들기 미감지 — grace period 적용
    liftConfirmedAt = null;

    if (liftedFoot !== null) {
      // 현재 들고 있는 중인데 미감지 → 유예 시작
      if (!dropStartedAt) {
        dropStartedAt = now;
      } else if (now - dropStartedAt >= CONFIG.DROP_GRACE_MS) {
        // 유예 시간 초과 → 실제로 발을 내렸다고 판정
        // dropStartedAt 시점을 종료 시점으로 사용 (유예 기간 동안의 부풀림 방지)
        if (liftStartTime) {
          const elapsed = (dropStartedAt - liftStartTime) / 1000;
          if (elapsed > maxDuration) {
            maxDuration = Math.round(elapsed * 10) / 10;
            bestLiftedFoot = liftedFoot;
          }
        }
        liftedFoot = null;
        liftStartTime = null;
        dropStartedAt = null;
      }
      // 유예 중에는 liftedFoot 유지 (노이즈일 수 있으므로)
    }
  }

  // 현재 유지 시간 (grace period 중에는 dropStartedAt 시점으로 동결)
  if (liftedFoot !== null && liftStartTime) {
    const effectiveNow = dropStartedAt || now;
    liftDuration = Math.round(((effectiveNow - liftStartTime) / 1000) * 10) / 10;
    if (liftDuration > maxDuration) {
      maxDuration = liftDuration;
      bestLiftedFoot = liftedFoot;
    }
  } else {
    liftDuration = 0;
  }

  return {
    isStanding,
    liftedFoot,
    liftDuration,
    maxDuration,
    bestLiftedFoot,
    yDiff: Math.round(yDiff * 1000) / 1000,
    targetDuration: CONFIG.TARGET_DURATION
  };
}

export function isSingleLegStanceComplete() {
  return completed;
}

export function markSingleLegStanceComplete() {
  completed = true;
}

/**
 * 점수 계산
 *
 * - 4점: 10초 이상 유지
 * - 3점: 5~10초 유지
 * - 2점: 3~5초 유지
 * - 1점: 3초 미만이지만 시도함
 * - 0점: 시도 불가 또는 균형 상실
 */
export function calculateSingleLegStanceScore(duration, attempted, lostBalance) {
  if (lostBalance || !attempted) {
    return { score: 0, reason: '시도 불가 또는 균형 상실' };
  }

  if (duration >= 10) {
    return { score: 4, reason: `${duration}초 유지 — 독립적으로 10초 이상` };
  }

  if (duration >= 5) {
    return { score: 3, reason: `${duration}초 유지 — 독립적으로 5초 이상` };
  }

  if (duration >= 3) {
    return { score: 2, reason: `${duration}초 유지 — 독립적으로 3초 이상` };
  }

  if (duration > 0) {
    return { score: 1, reason: `${duration}초 유지 — 3초 미만이지만 시도함` };
  }

  return { score: 0, reason: '한 발 들기를 감지하지 못함' };
}

export function generateSingleLegStanceReport(scoreResult, duration, liftedFoot) {
  const footLabel = liftedFoot === 'left' ? '왼발' : liftedFoot === 'right' ? '오른발' : '미감지';

  return {
    score: scoreResult.score,
    scoring: {
      autoScore: scoreResult.score,
      reason: scoreResult.reason
    },
    measurement: {
      maxDuration: duration,
      liftedFoot,
      liftedFootLabel: footLabel
    },
    testInfo: {
      item: '14. 한 발로 서기',
      method: 'AI 자동 측정'
    }
  };
}
