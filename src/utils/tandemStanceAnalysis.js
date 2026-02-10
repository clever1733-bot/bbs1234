/**
 * BBS 항목 13 - 일렬로 서기 / 탄뎀 서기 (Standing with One Foot in Front - Tandem Stance)
 *
 * 한 발을 다른 발 바로 앞에 놓고 30초간 유지.
 *
 * 측정 원리 — 양 발목 X좌표 간격 기반 탄뎀 자세 감지:
 *   좌/우 발목(27, 28)의 X좌표 간격을 어깨 폭 대비 비율로 계산.
 *   간격이 작을수록 더 정확한 탄뎀 자세.
 *   자세 유형(tandem / forward / small_step)별로 유지 시간 추적.
 *   30초 타이머 자동 완료.
 */

// ── 모듈 상태 ──
let initialState = null;
let stanceType = 'none';         // 'tandem' | 'forward' | 'small_step' | 'none'
let bestStanceType = 'none';     // 최고 자세
let stanceStartTime = null;      // 현재 자세 유지 시작 시각
let stanceDuration = 0;          // 현재 자세 유지 시간(초)
let maxDuration = 0;             // 최대 유지 시간
let completed = false;
let lostBalance = false;
let feetXGap = 0;                // 발 X 간격 (어깨 폭 대비 비율)
let feetYGap = 0;                // 발 Y 간격 (앞뒤 거리)
let stanceConfirmedAt = null;    // 자세 확인 시점 (디바운스)
let stanceLostAt = null;         // 자세 이탈 시작 시점 (유예용)

// ── 설정 (관대하게) ──
const CONFIG = {
  // 자세 판정 기준 (어깨 폭 대비 발목 X 간격 비율)
  TANDEM_X_RATIO: 0.25,          // 탄뎀: X간격 < 어깨폭 × 0.25 (관대)
  FORWARD_X_RATIO: 0.40,         // 앞뒤: X간격 < 어깨폭 × 0.40
  SMALL_STEP_X_RATIO: 0.60,      // 작은 보폭: X간격 < 어깨폭 × 0.60
  // 앞뒤 간격 최소 (한 발이 앞에 있어야 함)
  MIN_Y_GAP_RATIO: 0.03,         // 발목 Y 차이 최소 (bodyHeight 대비, 관대)
  // 타이머
  TARGET_DURATION: 30,            // 목표: 30초
  STANCE_CONFIRM_MS: 300,         // 자세 확인 디바운스 (0.3초)
  STANCE_LOST_MS: 500,            // 자세 이탈 허용 (0.5초)
};

// ── 유틸 ──

function getBodyHeight(landmarks) {
  const lShoulder = landmarks[11], rShoulder = landmarks[12];
  const lAnkle = landmarks[27], rAnkle = landmarks[28];
  const shoulderY = (lShoulder.y + rShoulder.y) / 2;
  const ankleY = (lAnkle.y + rAnkle.y) / 2;
  return Math.abs(ankleY - shoulderY);
}

function getShoulderWidth(landmarks) {
  return Math.abs(landmarks[11].x - landmarks[12].x);
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

function classifyStance(xGapRatio) {
  if (xGapRatio < CONFIG.TANDEM_X_RATIO) return 'tandem';
  if (xGapRatio < CONFIG.FORWARD_X_RATIO) return 'forward';
  if (xGapRatio < CONFIG.SMALL_STEP_X_RATIO) return 'small_step';
  return 'none';
}

function stanceRank(type) {
  switch (type) {
    case 'tandem': return 3;
    case 'forward': return 2;
    case 'small_step': return 1;
    default: return 0;
  }
}

// ── 공개 함수 ──

export function resetTandemStanceAnalysis() {
  initialState = null;
  stanceType = 'none';
  bestStanceType = 'none';
  stanceStartTime = null;
  stanceDuration = 0;
  maxDuration = 0;
  completed = false;
  lostBalance = false;
  feetXGap = 0;
  feetYGap = 0;
  stanceConfirmedAt = null;
  stanceLostAt = null;
}

export function recordTandemStanceInitial(landmarks) {
  if (!landmarks || landmarks.length < 33) return false;

  initialState = {
    shoulderWidth: getShoulderWidth(landmarks),
    bodyHeight: getBodyHeight(landmarks),
    timestamp: Date.now()
  };

  stanceType = 'none';
  bestStanceType = 'none';
  stanceStartTime = null;
  stanceDuration = 0;
  maxDuration = 0;
  completed = false;
  lostBalance = false;
  feetXGap = 0;
  feetYGap = 0;
  stanceConfirmedAt = null;
  stanceLostAt = null;

  return true;
}

/**
 * 매 프레임 분석
 */
export function analyzeTandemStance(landmarks) {
  if (!initialState) return null;
  if (!landmarks || landmarks.length < 33) return null;

  const now = Date.now();
  const isStanding = isStandingCheck(landmarks);

  const lAnkle = landmarks[27], rAnkle = landmarks[28];
  const shoulderWidth = initialState.shoulderWidth;
  const bodyHeight = initialState.bodyHeight;

  // 발목 간 X 간격 (어깨 폭 대비 비율)
  const rawXGap = Math.abs(lAnkle.x - rAnkle.x);
  const xGapRatio = shoulderWidth > 0.01 ? rawXGap / shoulderWidth : 1.0;
  feetXGap = Math.round(xGapRatio * 100) / 100;

  // 발목 간 Y 간격 (한 발이 앞에 있는지)
  const rawYGap = Math.abs(lAnkle.y - rAnkle.y);
  const yGapRatio = bodyHeight > 0.01 ? rawYGap / bodyHeight : 0;
  feetYGap = Math.round(yGapRatio * 100) / 100;

  // 앞뒤 거리가 있어야 탄뎀 자세 (한 발이 앞에)
  const hasFrontBack = yGapRatio >= CONFIG.MIN_Y_GAP_RATIO;

  // 자세 분류
  let detectedStance = 'none';
  if (isStanding && hasFrontBack) {
    detectedStance = classifyStance(xGapRatio);
  } else if (isStanding && xGapRatio < CONFIG.SMALL_STEP_X_RATIO) {
    // Y 간격 없어도 X가 좁으면 small_step으로 인정 (관대)
    detectedStance = 'small_step';
  }

  // 자세 전이 처리 (디바운스)
  if (detectedStance !== 'none') {
    // 자세 감지됨 — 이탈 유예 초기화
    stanceLostAt = null;

    if (stanceType === 'none') {
      // 자세 진입
      if (!stanceConfirmedAt) {
        stanceConfirmedAt = now;
      } else if (now - stanceConfirmedAt >= CONFIG.STANCE_CONFIRM_MS) {
        stanceType = detectedStance;
        stanceStartTime = now;
        stanceConfirmedAt = null;
      }
    } else {
      // 이미 자세 중 — 더 나은 자세로 업그레이드 가능
      if (stanceRank(detectedStance) > stanceRank(stanceType)) {
        stanceType = detectedStance;
      }
      stanceConfirmedAt = null;
    }
  } else {
    // 자세 미감지 — grace period 적용
    stanceConfirmedAt = null;

    if (stanceType !== 'none' && stanceStartTime) {
      if (!stanceLostAt) {
        stanceLostAt = now;
      } else if (now - stanceLostAt >= CONFIG.STANCE_LOST_MS) {
        // 유예 시간 초과 → 실제 이탈 확정
        // stanceLostAt 시점을 종료 시점으로 사용 (부풀림 방지)
        const elapsed = (stanceLostAt - stanceStartTime) / 1000;
        if (elapsed > maxDuration) {
          maxDuration = Math.round(elapsed * 10) / 10;
        }
        stanceType = 'none';
        stanceStartTime = null;
        stanceLostAt = null;
      }
      // 유예 중에는 stanceType 유지 (노이즈일 수 있으므로)
    }
  }

  // 유지 시간 계산 (grace period 중에는 stanceLostAt 시점으로 동결)
  if (stanceType !== 'none' && stanceStartTime) {
    const effectiveNow = stanceLostAt || now;
    stanceDuration = Math.round(((effectiveNow - stanceStartTime) / 1000) * 10) / 10;
    if (stanceDuration > maxDuration) {
      maxDuration = stanceDuration;
    }
    // 최고 자세 기록
    if (stanceRank(stanceType) > stanceRank(bestStanceType)) {
      bestStanceType = stanceType;
    }
  } else {
    stanceDuration = 0;
  }

  // 어느 발이 앞에?
  let frontFoot = null;
  if (lAnkle.y < rAnkle.y) {
    frontFoot = 'left';  // 정규화 Y에서 작을수록 위(앞)
  } else if (rAnkle.y < lAnkle.y) {
    frontFoot = 'right';
  }

  return {
    isStanding,
    stanceType,
    bestStanceType,
    stanceDuration,
    maxDuration,
    feetXGap,
    feetYGap,
    frontFoot,
    targetDuration: CONFIG.TARGET_DURATION
  };
}

export function isTandemStanceComplete() {
  return completed;
}

export function markTandemStanceComplete() {
  completed = true;
}

/**
 * 점수 계산
 *
 * - 4점: 탄뎀 자세로 30초 유지
 * - 3점: 앞뒤 자세로 30초 유지
 * - 2점: 작은 보폭으로 30초 유지
 * - 1점: 도움 필요하지만 15초 유지
 * - 0점: 균형 상실
 */
export function calculateTandemStanceScore(bestStance, duration, balanceLost) {
  if (balanceLost || duration < 5) {
    return { score: 0, reason: `유지 시간 ${duration}초 — 균형 상실` };
  }

  if (bestStance === 'tandem' && duration >= 30) {
    return { score: 4, reason: `탄뎀 자세 ${duration}초 유지 — 독립적으로 완수` };
  }

  if ((bestStance === 'tandem' || bestStance === 'forward') && duration >= 30) {
    return { score: 3, reason: `앞뒤 자세 ${duration}초 유지 — 독립적으로 완수` };
  }

  if (duration >= 30) {
    return { score: 2, reason: `작은 보폭으로 ${duration}초 유지` };
  }

  if (duration >= 15) {
    return { score: 1, reason: `${duration}초 유지 — 도움 필요` };
  }

  return { score: 0, reason: `유지 시간 ${duration}초 — 균형 유지 불가` };
}

export function generateTandemStanceReport(scoreResult, bestStance, duration, feetXGapVal) {
  const stanceLabels = {
    tandem: '탄뎀 (일렬)',
    forward: '앞뒤 자세',
    small_step: '작은 보폭',
    none: '미감지'
  };

  return {
    score: scoreResult.score,
    scoring: {
      autoScore: scoreResult.score,
      reason: scoreResult.reason
    },
    measurement: {
      bestStanceType: bestStance,
      bestStanceLabel: stanceLabels[bestStance] || '미감지',
      maxDuration: duration,
      feetXGap: feetXGapVal
    },
    testInfo: {
      item: '13. 일렬로 서기 (탄뎀 서기)',
      method: 'AI 자동 측정'
    }
  };
}
