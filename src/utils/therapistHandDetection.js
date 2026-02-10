/**
 * 치료사 손 감지 시스템 (MediaPipe Hands)
 *
 * BBS 검사 시 치료사가 환자 근처에 손을 대면(물리적 개입)
 * 항목별 규칙에 따라 점수를 제한한다.
 *
 * 감지 로직:
 * - Pose 손목(15,16)과 Hands 손목(0)의 거리 비교로 환자 손 매칭
 * - 매칭 안 되는 손 = 제3자(치료사) 손
 * - 치료사 손이 환자 바디 바운딩 박스 안에 있으면 개입으로 판정
 */

// ── 모듈 상태 ──
let handsInstance = null;
let isInitialized = false;
let isInitializing = false;
let latestResults = null;
let frameCounter = 0;
let consecutiveDetections = 0;

const FRAME_SKIP = 5;        // 5프레임마다 1회 처리 (성능)
const CONFIRM_THRESHOLD = 3; // 연속 3회 감지 시 확정 (~0.5초)
const MATCH_DIST = 0.08;     // 환자 손 매칭 임계 거리 (정규화 좌표)
const BODY_MARGIN = 0.15;    // 바운딩 박스 마진 15%

/**
 * MediaPipe Hands 초기화
 */
export async function initHandsDetection() {
  if (isInitialized || isInitializing) return;
  isInitializing = true;

  try {
    const { Hands } = await import('@mediapipe/hands');

    handsInstance = new Hands({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
    });

    handsInstance.setOptions({
      maxNumHands: 4,
      modelComplexity: 0,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5
    });

    handsInstance.onResults((results) => {
      latestResults = results;
    });

    // 모델 워밍업: 빈 캔버스 전송
    const warmupCanvas = document.createElement('canvas');
    warmupCanvas.width = 64;
    warmupCanvas.height = 64;
    try {
      await handsInstance.send({ image: warmupCanvas });
    } catch {
      // 워밍업 실패 무시
    }

    isInitialized = true;
  } catch (err) {
    console.warn('MediaPipe Hands 초기화 실패:', err);
  } finally {
    isInitializing = false;
  }
}

/**
 * 프레임을 Hands 모델에 전송 (FRAME_SKIP 적용)
 */
export async function sendFrameToHands(videoElement) {
  if (!handsInstance || !isInitialized) return;
  frameCounter++;
  if (frameCounter % FRAME_SKIP !== 0) return;

  try {
    await handsInstance.send({ image: videoElement });
  } catch {
    // 프레임 전송 오류 무시
  }
}

/**
 * 치료사 손 감지 체크
 * @param {Array} poseLandmarks - MediaPipe Pose 랜드마크 (33개)
 * @returns {{ detected: boolean, handCount: number, extraHandsNearBody: number }}
 */
export function checkTherapistHands(poseLandmarks) {
  const result = { detected: false, handCount: 0, extraHandsNearBody: 0 };

  if (!latestResults || !latestResults.multiHandLandmarks || !poseLandmarks) {
    consecutiveDetections = 0;
    return result;
  }

  const hands = latestResults.multiHandLandmarks;
  result.handCount = hands.length;

  // 손이 2개 이하면 치료사 없음
  if (hands.length <= 2) {
    consecutiveDetections = 0;
    return result;
  }

  // 환자 손목 위치 (Pose 랜드마크 15=왼손목, 16=오른손목)
  const poseLeftWrist = poseLandmarks[15];
  const poseRightWrist = poseLandmarks[16];

  // 환자 바디 바운딩 박스 계산
  // 랜드마크: 11,12(어깨), 23,24(엉덩이), 25,26(무릎), 27,28(발목)
  const bodyIndices = [11, 12, 23, 24, 25, 26, 27, 28];
  let minX = 1, maxX = 0, minY = 1, maxY = 0;
  for (const idx of bodyIndices) {
    const lm = poseLandmarks[idx];
    if (lm) {
      if (lm.x < minX) minX = lm.x;
      if (lm.x > maxX) maxX = lm.x;
      if (lm.y < minY) minY = lm.y;
      if (lm.y > maxY) maxY = lm.y;
    }
  }
  // 마진 적용
  const bw = maxX - minX;
  const bh = maxY - minY;
  const bodyBox = {
    left: minX - bw * BODY_MARGIN,
    right: maxX + bw * BODY_MARGIN,
    top: minY - bh * BODY_MARGIN,
    bottom: maxY + bh * BODY_MARGIN
  };

  // 각 감지된 손에 대해 환자 손 매칭 시도
  let extraHandsNearBody = 0;

  for (const handLandmarks of hands) {
    const handWrist = handLandmarks[0]; // Hands 랜드마크 0 = 손목

    // 환자 왼손목과 거리
    const distLeft = Math.hypot(
      handWrist.x - poseLeftWrist.x,
      handWrist.y - poseLeftWrist.y
    );
    // 환자 오른손목과 거리
    const distRight = Math.hypot(
      handWrist.x - poseRightWrist.x,
      handWrist.y - poseRightWrist.y
    );

    // 환자 손이면 스킵
    if (distLeft < MATCH_DIST || distRight < MATCH_DIST) {
      continue;
    }

    // 제3자 손 — 환자 바디 바운딩 박스 안에 있는지 체크
    if (
      handWrist.x >= bodyBox.left && handWrist.x <= bodyBox.right &&
      handWrist.y >= bodyBox.top && handWrist.y <= bodyBox.bottom
    ) {
      extraHandsNearBody++;
    }
  }

  result.extraHandsNearBody = extraHandsNearBody;

  // 디바운스: 연속 감지 확인
  if (extraHandsNearBody > 0) {
    consecutiveDetections++;
  } else {
    consecutiveDetections = 0;
  }

  if (consecutiveDetections >= CONFIRM_THRESHOLD) {
    result.detected = true;
  }

  return result;
}

/**
 * 치료사 개입 시 점수 캡 적용
 *
 * | 항목 (0-indexed) | 규칙                                    |
 * |------------------|-----------------------------------------|
 * | 7,8,9,10,13      | 0점 캡                                  |
 * | 11               | stepCount ≥ 2이면 1점, 아니면 0점       |
 * | 12               | holdDuration ≥ 15이면 1점, 아니면 0점   |
 *
 * @param {{ score: number, reason: string }} scoreResult
 * @param {number} itemIndex - 0-based item index
 * @param {{ stepCount?: number, holdDuration?: number }} itemSpecificData
 * @returns {{ score: number, reason: string }}
 */
export function applyTherapistScoreCap(scoreResult, itemIndex, itemSpecificData = {}) {
  if (!scoreResult) return scoreResult;

  const zeroCapItems = [7, 8, 9, 10, 13]; // items 8,9,10,11,14 (0-indexed)
  const suffix = ' (치료사 개입 감지)';

  if (zeroCapItems.includes(itemIndex)) {
    if (scoreResult.score > 0) {
      return {
        score: 0,
        reason: scoreResult.reason + suffix
      };
    }
    return scoreResult;
  }

  // 항목 12 (index 11): stepCount ≥ 2이면 1점, 아니면 0점
  if (itemIndex === 11) {
    const cap = (itemSpecificData.stepCount >= 2) ? 1 : 0;
    if (scoreResult.score > cap) {
      return {
        score: cap,
        reason: scoreResult.reason + suffix
      };
    }
    return scoreResult;
  }

  // 항목 13 (index 12): holdDuration ≥ 15이면 1점, 아니면 0점
  if (itemIndex === 12) {
    const cap = (itemSpecificData.holdDuration >= 15) ? 1 : 0;
    if (scoreResult.score > cap) {
      return {
        score: cap,
        reason: scoreResult.reason + suffix
      };
    }
    return scoreResult;
  }

  return scoreResult;
}

/**
 * 상태 리셋 (항목 시작 시)
 */
export function resetHandDetection() {
  latestResults = null;
  frameCounter = 0;
  consecutiveDetections = 0;
}

/**
 * Hands 인스턴스 해제 (언마운트 시)
 */
export function destroyHandsDetection() {
  if (handsInstance) {
    try {
      handsInstance.close();
    } catch {
      // close 실패 무시
    }
    handsInstance = null;
  }
  isInitialized = false;
  isInitializing = false;
  latestResults = null;
  frameCounter = 0;
  consecutiveDetections = 0;
}
