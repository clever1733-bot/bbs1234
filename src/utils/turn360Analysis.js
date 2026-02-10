/**
 * BBS 항목 11 - 360도 회전 (Turning 360 Degrees)
 *
 * 서 있는 자세에서 한 방향으로 360° 회전 후, 반대 방향으로 360° 회전.
 *
 * 측정 원리 — 어깨 폭 비율 기반 사이클 감지:
 *   정면(1.0) → 측면(↓) → 후면(최소) → 측면(↑) → 정면(1.0)
 *   이 사이클이 감지되면 1회전 완료.
 *
 * 포즈 소실 없이도 회전 감지 가능 (대체 경로):
 *   어깨 폭이 충분히 줄었다가(< 0.50) 다시 회복(> 0.70)하면 완료.
 */

// ── 위상(Phase) 상수 ──
const Phase = {
  FACING_FRONT: 'facing_front',
  TURNING_AWAY: 'turning_away',
  POSE_LOST: 'pose_lost',
  RETURNING: 'returning',
  TURN_COMPLETE: 'turn_complete'
};

// ── 모듈 상태 ──
let initialState = null;
let phase = Phase.FACING_FRONT;
let feetEverMoved = false;

let turnStartTime = null;
let poseLostTime = null;
let turnDirection = 'unknown';
let maxWidthRatio = 1.0;
let minWidthRatio = 1.0;
let poseLostDuration = 0;
let framesSinceReturn = 0;

let widthRatioHistory = [];
const MAX_HISTORY = 300;

// ── 설정 ──
const CONFIG = {
  MIN_WIDTH_RATIO_FOR_SIDE: 0.75,    // 측면 진입 판단 (관대)
  MIN_WIDTH_RATIO_FOR_LOST: 0.35,    // 포즈 소실 예상
  RETURN_WIDTH_RATIO: 0.55,
  FRONT_WIDTH_RATIO: 0.70,           // 정면 복귀 판단 (관대)
  DEEP_TURN_RATIO: 0.50,             // 충분한 회전 판단 (대체 경로)
  MIN_POSE_LOST_MS: 200,             // 최소 포즈 소실 시간
  MAX_POSE_LOST_MS: 15000,
  FRONT_CONFIRM_FRAMES: 4,           // 정면 복귀 확인 (빠르게)
  FAST_TURN_SEC: 4,
  VISIBILITY_THRESHOLD: 0.5
};

const CORE_LANDMARKS = [11, 12, 23, 24, 25, 26, 27, 28];

// ── 유틸 ──

function getShoulderWidth(landmarks) {
  const l = landmarks[11], r = landmarks[12];
  return Math.abs(l.x - r.x);
}

function getCoreVisibility(landmarks) {
  let sum = 0;
  for (const idx of CORE_LANDMARKS) {
    sum += (landmarks[idx]?.visibility || 0);
  }
  return sum / CORE_LANDMARKS.length;
}

function detectDirection(landmarks) {
  if (!initialState) return 'unknown';
  const lShoulder = landmarks[11], rShoulder = landmarks[12];
  const currentZDiff = (lShoulder.z || 0) - (rShoulder.z || 0);
  const zDelta = currentZDiff - initialState.shoulderZDiff;

  if (Math.abs(zDelta) > 0.03) {
    return zDelta > 0 ? 'left' : 'right';
  }

  const nose = landmarks[0];
  const shoulderMidX = (lShoulder.x + rShoulder.x) / 2;
  const currentNoseOffset = nose.x - shoulderMidX;
  const noseDelta = currentNoseOffset - initialState.noseOffset;

  if (Math.abs(noseDelta) > 0.015) {
    return noseDelta < 0 ? 'left' : 'right';
  }

  return 'unknown';
}

function checkFeetMoved(landmarks) {
  if (!initialState) return false;
  const lAnkle = landmarks[27], rAnkle = landmarks[28];
  const lDist = Math.hypot(lAnkle.x - initialState.ankles.lx, lAnkle.y - initialState.ankles.ly);
  const rDist = Math.hypot(rAnkle.x - initialState.ankles.rx, rAnkle.y - initialState.ankles.ry);
  return lDist > 0.12 || rDist > 0.12;
}

// ── 공개 함수 ──

export function resetTurn360Analysis() {
  initialState = null;
  phase = Phase.FACING_FRONT;
  feetEverMoved = false;
  turnStartTime = null;
  poseLostTime = null;
  turnDirection = 'unknown';
  maxWidthRatio = 1.0;
  minWidthRatio = 1.0;
  poseLostDuration = 0;
  framesSinceReturn = 0;
  widthRatioHistory = [];
}

export function recordTurn360Initial(landmarks) {
  if (!landmarks || landmarks.length < 33) return false;

  const lShoulder = landmarks[11], rShoulder = landmarks[12];
  const lAnkle = landmarks[27], rAnkle = landmarks[28];
  const nose = landmarks[0];
  const lHip = landmarks[23], rHip = landmarks[24];

  const shoulderWidth = Math.abs(lShoulder.x - rShoulder.x);
  const shoulderMidX = (lShoulder.x + rShoulder.x) / 2;

  initialState = {
    shoulderWidth,
    shoulderMidX,
    noseX: nose.x,
    noseOffset: nose.x - shoulderMidX,
    shoulderZDiff: (lShoulder.z || 0) - (rShoulder.z || 0),
    torsoHeight: Math.abs((lShoulder.y + rShoulder.y) / 2 - (lHip.y + rHip.y) / 2),
    ankles: {
      lx: lAnkle.x, ly: lAnkle.y,
      rx: rAnkle.x, ry: rAnkle.y
    },
    timestamp: Date.now()
  };

  phase = Phase.FACING_FRONT;
  turnStartTime = null;
  poseLostTime = null;
  turnDirection = 'unknown';
  maxWidthRatio = 1.0;
  minWidthRatio = 1.0;
  poseLostDuration = 0;
  framesSinceReturn = 0;
  widthRatioHistory = [];
  return true;
}

/**
 * 매 프레임 분석
 */
export function analyzeTurn360(landmarks, poseAvailable) {
  if (!initialState) return null;
  const now = Date.now();

  // ── 포즈 소실 처리 ──
  if (!poseAvailable || !landmarks || landmarks.length < 33) {
    if (phase === Phase.TURNING_AWAY || phase === Phase.FACING_FRONT) {
      if (!poseLostTime) poseLostTime = now;
      poseLostDuration = now - poseLostTime;
      if (poseLostDuration >= CONFIG.MIN_POSE_LOST_MS) {
        phase = Phase.POSE_LOST;
      }
    }
    if (phase === Phase.POSE_LOST && poseLostTime) {
      poseLostDuration = now - poseLostTime;
    }

    return {
      phase,
      widthRatio: 0,
      turnDirection,
      poseLost: true,
      poseLostDuration: Math.round(poseLostDuration / 1000 * 10) / 10,
      elapsedSec: turnStartTime ? Math.round((now - turnStartTime) / 100) / 10 : 0,
      feetMoved: false,
      feetEverMoved,
      isStanding: false,
      progress: getProgressPercent()
    };
  }

  // ── 포즈 가용 ──
  const lShoulder = landmarks[11], rShoulder = landmarks[12];
  const lHip = landmarks[23], rHip = landmarks[24];
  const lAnkle = landmarks[27], rAnkle = landmarks[28];

  const shoulderY = (lShoulder.y + rShoulder.y) / 2;
  const hipY = (lHip.y + rHip.y) / 2;
  const ankleY = (lAnkle.y + rAnkle.y) / 2;
  const denom = ankleY - shoulderY;
  const hipToAnkleRatio = denom > 0.001 ? (ankleY - hipY) / denom : 0;
  const isStanding = hipToAnkleRatio > 0.45;

  const currentWidth = getShoulderWidth(landmarks);
  const widthRatio = initialState.shoulderWidth > 0.02
    ? currentWidth / initialState.shoulderWidth
    : 1.0;

  widthRatioHistory.push({ ratio: widthRatio, time: now });
  if (widthRatioHistory.length > MAX_HISTORY) widthRatioHistory.shift();

  const feetMoved = checkFeetMoved(landmarks);
  if (feetMoved) feetEverMoved = true;

  const visibility = getCoreVisibility(landmarks);
  const detectedDir = detectDirection(landmarks);

  // ── 위상 전이 ──
  switch (phase) {
    case Phase.FACING_FRONT: {
      maxWidthRatio = Math.max(maxWidthRatio, widthRatio);
      if (widthRatio < CONFIG.MIN_WIDTH_RATIO_FOR_SIDE) {
        phase = Phase.TURNING_AWAY;
        if (!turnStartTime) turnStartTime = now;
        if (detectedDir !== 'unknown') turnDirection = detectedDir;
        minWidthRatio = widthRatio;
      }
      break;
    }
    case Phase.TURNING_AWAY: {
      minWidthRatio = Math.min(minWidthRatio, widthRatio);
      if (detectedDir !== 'unknown' && turnDirection === 'unknown') {
        turnDirection = detectedDir;
      }

      if (poseLostTime) {
        poseLostTime = null;
        poseLostDuration = 0;
      }

      // 경로 A: 어깨 폭이 매우 줄고 visibility 낮음 → 포즈 소실
      if (widthRatio < CONFIG.MIN_WIDTH_RATIO_FOR_LOST && visibility < CONFIG.VISIBILITY_THRESHOLD) {
        poseLostTime = now;
        phase = Phase.POSE_LOST;
        break;
      }

      // 경로 B (대체): 충분히 줄었다가 다시 회복 → 포즈 소실 없이 회전 완료
      if (minWidthRatio < CONFIG.DEEP_TURN_RATIO && widthRatio >= CONFIG.FRONT_WIDTH_RATIO) {
        phase = Phase.TURN_COMPLETE;
      }
      break;
    }
    case Phase.POSE_LOST: {
      // 포즈 다시 감지됨
      phase = Phase.RETURNING;
      framesSinceReturn = 0;
      break;
    }
    case Phase.RETURNING: {
      framesSinceReturn++;
      if (detectedDir !== 'unknown' && turnDirection === 'unknown') {
        turnDirection = detectedDir;
      }
      if (widthRatio >= CONFIG.FRONT_WIDTH_RATIO && framesSinceReturn >= CONFIG.FRONT_CONFIRM_FRAMES) {
        phase = Phase.TURN_COMPLETE;
      }
      break;
    }
    case Phase.TURN_COMPLETE:
      break;
  }

  return {
    phase,
    widthRatio: Math.round(widthRatio * 100) / 100,
    turnDirection,
    poseLost: false,
    poseLostDuration: Math.round(poseLostDuration / 1000 * 10) / 10,
    elapsedSec: turnStartTime ? Math.round((now - turnStartTime) / 100) / 10 : 0,
    isStanding,
    feetMoved,
    feetEverMoved,
    visibility: Math.round(visibility * 100),
    progress: getProgressPercent()
  };
}

function getProgressPercent() {
  switch (phase) {
    case Phase.FACING_FRONT: return 0;
    case Phase.TURNING_AWAY: return 25;
    case Phase.POSE_LOST: return 50;
    case Phase.RETURNING: return 75;
    case Phase.TURN_COMPLETE: return 100;
    default: return 0;
  }
}

export function harvestCurrentTurnResult() {
  const now = Date.now();
  const elapsed = turnStartTime ? (now - turnStartTime) / 1000 : 0;

  return {
    direction: turnDirection,
    elapsedSec: Math.round(elapsed * 10) / 10,
    completed: phase === Phase.TURN_COMPLETE,
    feetMoved: feetEverMoved,
    poseLostDuration: Math.round(poseLostDuration / 1000 * 10) / 10,
    safe: !feetEverMoved && elapsed <= CONFIG.FAST_TURN_SEC * 2
  };
}

export function prepareTurn360SecondTurn(landmarks) {
  if (landmarks && landmarks.length >= 33) {
    const lAnkle = landmarks[27], rAnkle = landmarks[28];
    if (initialState) {
      initialState.ankles = { lx: lAnkle.x, ly: lAnkle.y, rx: rAnkle.x, ry: rAnkle.y };
      initialState.shoulderWidth = getShoulderWidth(landmarks);
      const lShoulder = landmarks[11], rShoulder = landmarks[12];
      const shoulderMidX = (lShoulder.x + rShoulder.x) / 2;
      initialState.shoulderMidX = shoulderMidX;
      initialState.shoulderZDiff = (lShoulder.z || 0) - (rShoulder.z || 0);
      const nose = landmarks[0];
      initialState.noseOffset = nose.x - shoulderMidX;
    }
  }

  phase = Phase.FACING_FRONT;
  feetEverMoved = false;
  turnStartTime = null;
  poseLostTime = null;
  turnDirection = 'unknown';
  maxWidthRatio = 1.0;
  minWidthRatio = 1.0;
  poseLostDuration = 0;
  framesSinceReturn = 0;
  widthRatioHistory = [];
}

export function isTurn360TurnComplete() {
  return phase === Phase.TURN_COMPLETE;
}

export function markTurn360Complete() {
  phase = Phase.TURN_COMPLETE;
}

/**
 * 점수 계산
 *
 * - 4점: 양방향 360° 완료, 각각 4초 이내, 안전
 * - 3점: 양방향 360° 완료, 한 방향만 4초 이내
 * - 2점: 360° 완료했지만 느림
 * - 1점: 한쪽만 완료 또는 감독 필요
 * - 0점: 360° 미완료
 */
export function calculateTurn360Score(first, second) {
  const firstDone = first && first.completed;
  const secondDone = second && second.completed;

  if (!firstDone && !secondDone) {
    return { score: 0, reason: '360도 회전을 완료할 수 없음' };
  }

  if (!firstDone || !secondDone) {
    const done = firstDone ? first : second;
    return { score: 1, reason: `한 방향만 회전 가능 (${done.elapsedSec}초) — 감독 필요` };
  }

  const firstFast = first.elapsedSec <= CONFIG.FAST_TURN_SEC;
  const secondFast = second.elapsedSec <= CONFIG.FAST_TURN_SEC;

  // 360° 회전에서 발 이동은 필수적이므로 feetMoved는 채점에 반영하지 않음
  if (firstFast && secondFast) {
    return {
      score: 4,
      reason: `양방향 4초 이내 안전 완료 (${first.elapsedSec}초 / ${second.elapsedSec}초)`
    };
  }

  if (firstFast || secondFast) {
    return {
      score: 3,
      reason: `한 방향 4초 이내 완료 (${first.elapsedSec}초 / ${second.elapsedSec}초)`
    };
  }

  return {
    score: 2,
    reason: `양방향 완료, 느림 (${first.elapsedSec}초 / ${second.elapsedSec}초)`
  };
}

export function generateTurn360Report(scoreResult, first, second, feetMoved) {
  return {
    score: scoreResult.score,
    scoring: {
      autoScore: scoreResult.score,
      reason: scoreResult.reason
    },
    measurement: {
      firstTurn: first ? {
        direction: first.direction,
        elapsedSec: first.elapsedSec,
        completed: first.completed,
        poseLostDuration: first.poseLostDuration
      } : null,
      secondTurn: second ? {
        direction: second.direction,
        elapsedSec: second.elapsedSec,
        completed: second.completed,
        poseLostDuration: second.poseLostDuration
      } : null,
      feetMoved
    },
    testInfo: {
      item: '11. 360도 회전',
      method: 'AI 자동 측정'
    }
  };
}
