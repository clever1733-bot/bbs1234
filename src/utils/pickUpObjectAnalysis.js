/**
 * BBS 항목 9 - 바닥의 물건 집기 (Pick Up Object From Floor)
 *
 * 서기 → 허리 굽히기 → 서기 동작 순서를 감지하고,
 * 손목이 바닥(발목 높이)까지 도달했는지 측정.
 *
 * 핵심 개선:
 *  - initialState 없이도 첫 프레임 기준으로 추적 가능
 *  - reachedFloor 판정에 여유 마진 적용 (체고의 8%)
 *  - 깊은 굽힘(hipAngle < 70°) 자체를 바닥 도달 보조 신호로 활용
 */

// ── 모듈 상태 ──
let initialState = null;
let firstAnkles = null;          // initialState 없을 때 발 위치 기준
let minWristToAnkle = Infinity;
let everReachedFloor = false;    // 한 번이라도 바닥 도달하면 true 유지
let completed = false;
let feetEverMoved = false;
let phaseHistory = [];

const ESTIMATED_TORSO_CM = 50;

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

// ── 공개 함수 ──

export function resetPickUpAnalysis() {
  initialState = null;
  firstAnkles = null;
  minWristToAnkle = Infinity;
  everReachedFloor = false;
  completed = false;
  feetEverMoved = false;
  phaseHistory = [];
}

export function markPickUpComplete() {
  completed = true;
}

export function recordPickUpInitial(landmarks, aspectRatio) {
  if (!landmarks || landmarks.length < 33) return false;

  const lShoulder = landmarks[11], rShoulder = landmarks[12];
  const lHip = landmarks[23], rHip = landmarks[24];
  const lAnkle = landmarks[27], rAnkle = landmarks[28];

  const shoulderY = (lShoulder.y + rShoulder.y) / 2;
  const hipY = (lHip.y + rHip.y) / 2;
  const ankleY = (lAnkle.y + rAnkle.y) / 2;

  initialState = {
    shoulderY,
    hipY,
    ankleY,
    torsoHeight: Math.abs(shoulderY - hipY),
    aspectRatio: aspectRatio || (16 / 9),
    ankles: {
      lx: lAnkle.x, ly: lAnkle.y,
      rx: rAnkle.x, ry: rAnkle.y
    },
    timestamp: Date.now()
  };

  firstAnkles = initialState.ankles;
  minWristToAnkle = Infinity;
  // everReachedFloor는 리셋하지 않음 — 이전에 바닥 도달했으면 유지
  completed = false;
  feetEverMoved = false;
  phaseHistory = [];
  return true;
}

/**
 * 매 프레임 호출 — 분석
 */
export function analyzePickUp(landmarks) {
  if (!landmarks || landmarks.length < 33) return null;

  const lShoulder = landmarks[11], rShoulder = landmarks[12];
  const lHip = landmarks[23], rHip = landmarks[24];
  const lKnee = landmarks[25], rKnee = landmarks[26];
  const lAnkle = landmarks[27], rAnkle = landmarks[28];
  const lWrist = landmarks[15], rWrist = landmarks[16];

  const shoulderY = (lShoulder.y + rShoulder.y) / 2;
  const hipY = (lHip.y + rHip.y) / 2;
  const ankleY = (lAnkle.y + rAnkle.y) / 2;
  const kneeY = (lKnee.y + rKnee.y) / 2;

  // 첫 프레임에서 발 위치 기준 저장 (initialState 없어도 동작)
  if (!firstAnkles) {
    firstAnkles = { lx: lAnkle.x, ly: lAnkle.y, rx: rAnkle.x, ry: rAnkle.y };
  }

  // 서있음 판정
  const hipToAnkleRatio = (ankleY - hipY) / (ankleY - shoulderY);
  const isStanding = hipToAnkleRatio > 0.45;

  // 허리 굽힘 각도
  const shoulderMid = { x: (lShoulder.x + rShoulder.x) / 2, y: shoulderY };
  const hipMid = { x: (lHip.x + rHip.x) / 2, y: hipY };
  const kneeMid = { x: (lKnee.x + rKnee.x) / 2, y: kneeY };

  const hipAngle = calcAngle(shoulderMid, hipMid, kneeMid);
  const bendAngle = hipAngle;

  const shoulderNearHip = Math.abs(shoulderY - hipY) < Math.abs(ankleY - hipY) * 0.3;
  const isBending = hipAngle < 120 || shoulderNearHip;

  // 양쪽 손목 중 더 낮은(바닥에 가까운) 것 사용
  const activeWrist = lWrist.y > rWrist.y ? lWrist : rWrist;

  // 손목-발목 거리 (cm)
  let wristToAnkleCm = 0;
  const refTorso = initialState ? initialState.torsoHeight : Math.abs(shoulderY - hipY);
  if (refTorso > 0.01) {
    wristToAnkleCm = ((ankleY - activeWrist.y) / refTorso) * ESTIMATED_TORSO_CM;
  }

  // ── 바닥 도달 판정 (관대한 기준) ──
  // 1) 손목이 발목 높이 근처 (체고의 15% 마진)
  const bodyHeight = Math.abs(ankleY - shoulderY);
  const floorMargin = bodyHeight * 0.15;
  const wristNearFloor = activeWrist.y >= (ankleY - floorMargin);

  // 2) 허리 굽힘 + 손목이 무릎 아래 (물건 집기의 핵심 동작)
  const bendAndReach = isBending && activeWrist.y >= kneeY;

  // 3) cm 기반: wristToAnkleCm <= 8cm (발목에서 8cm 이내)
  const cmNearFloor = wristToAnkleCm <= 8;

  const reachedFloor = wristNearFloor || bendAndReach || cmNearFloor;
  if (reachedFloor && !completed) everReachedFloor = true;

  // ── 최소 거리 추적 (initialState 없이도 동작) ──
  if (!completed) {
    if (wristToAnkleCm < minWristToAnkle) {
      minWristToAnkle = wristToAnkleCm;
    }
  }

  // ── 발 움직임 체크 (initialState 없이도 firstAnkles 사용) ──
  let feetMoved = false;
  const refAnkles = initialState ? initialState.ankles : firstAnkles;
  if (refAnkles) {
    const lDist = Math.hypot(lAnkle.x - refAnkles.lx, lAnkle.y - refAnkles.ly);
    const rDist = Math.hypot(rAnkle.x - refAnkles.rx, rAnkle.y - refAnkles.ry);
    feetMoved = lDist > 0.12 || rDist > 0.12;
    if (feetMoved) feetEverMoved = true;
  }

  // 복귀 판정
  const returnedToStand = hipAngle > 160 && isStanding;

  const minDistResult = minWristToAnkle === Infinity ? wristToAnkleCm : minWristToAnkle;

  return {
    isStanding,
    isBending,
    bendAngle: Math.round(bendAngle),
    wristToAnkleCm: Math.round(wristToAnkleCm * 10) / 10,
    minWristToAnkleCm: Math.round(minDistResult * 10) / 10,
    reachedFloor,
    everReachedFloor,
    feetMoved,
    feetEverMoved,
    returnedToStand,
    wristPos: { x: activeWrist.x, y: activeWrist.y }
  };
}

/**
 * standing→bending→standing 완료 판정
 */
export function isPickUpSequenceComplete() {
  if (phaseHistory.length < 3) return false;

  let foundStanding1 = false;
  let foundBending = false;

  for (const entry of phaseHistory) {
    if (!foundStanding1) {
      if (entry.phase === 'standing') foundStanding1 = true;
    } else if (!foundBending) {
      if (entry.phase === 'bending') foundBending = true;
    } else {
      if (entry.phase === 'standing') return true;
    }
  }
  return false;
}

/**
 * phaseHistory에 현재 phase 기록 (중복 연속 방지)
 */
export function recordPhase(phase) {
  const last = phaseHistory.length > 0 ? phaseHistory[phaseHistory.length - 1] : null;
  if (!last || last.phase !== phase) {
    phaseHistory.push({ phase, time: Date.now() });
  }
}

/**
 * 점수 계산
 *
 * BBS 원래 기준:
 * - 4점: 안전하고 쉽게 물건을 집을 수 있음
 * - 3점: 물건을 집었으나 감독이 필요함
 * - 2점: 집지 못하지만 바닥에서 2-5cm 이내, 균형 유지
 * - 1점: 집지 못하고 감독 필요
 * - 0점: 시도 불가 / 균형 상실
 */
export function calculatePickUpScore(minDist, reachedFloor, feetEverMoved, lostBalance) {
  if (lostBalance) {
    return { score: 0, reason: '균형을 잃어 외부 지지가 필요합니다' };
  }
  if (reachedFloor && !feetEverMoved) {
    return { score: 4, reason: '안전하고 쉽게 물건을 집을 수 있음' };
  }
  if (reachedFloor && feetEverMoved) {
    return { score: 3, reason: '물건을 집었으나 감독이 필요함' };
  }
  if (minDist <= 5 && !feetEverMoved) {
    return { score: 2, reason: `바닥까지 ${minDist.toFixed(1)}cm — 바닥 미도달, 균형 유지` };
  }
  if (minDist > 0) {
    return { score: 1, reason: `바닥까지 ${minDist.toFixed(1)}cm — 감독 필요` };
  }
  return { score: 0, reason: '물건 집기를 수행할 수 없음' };
}

/**
 * 리포트 생성
 */
export function generatePickUpReport(scoreResult, minDist, reachedFloor, feetEverMoved) {
  return {
    score: scoreResult.score,
    scoring: {
      autoScore: scoreResult.score,
      reason: scoreResult.reason
    },
    measurement: {
      minWristToAnkleCm: minDist.toFixed(1),
      reachedFloor,
      feetMoved: feetEverMoved
    },
    testInfo: {
      item: '9. 바닥의 물건 집기',
      method: 'AI 자동 측정'
    }
  };
}
