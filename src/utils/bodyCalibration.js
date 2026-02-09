/**
 * 신체 캘리브레이션 유틸리티
 *
 * 환자의 키(cm)와 MediaPipe 랜드마크를 이용해
 * 영상 속 정규화 좌표 → 실제 cm 변환 스케일을 계산한다.
 *
 * 원리:
 *  1. MediaPipe 33개 관절점에서 수직 신체 부위 길이를 측정 (정규화 좌표)
 *  2. 머리~발끝 전체 높이의 정규화 값으로부터 cm/unit 스케일을 구함
 *  3. 가로(x) 방향은 영상 종횡비(aspect ratio)를 반영하여 보정
 *
 * MediaPipe Pose 랜드마크 인덱스:
 *  0: 코, 11/12: 어깨, 13/14: 팔꿈치, 15/16: 손목
 *  19/20: 검지, 23/24: 엉덩이, 25/26: 무릎, 27/28: 발목, 31/32: 발끝
 */

// ── 캘리브레이션 상태 ──
let calibrationData = null;

/**
 * 캘리브레이션 초기화
 */
export function resetCalibration() {
  calibrationData = null;
}

/**
 * 캘리브레이션 수행
 *
 * @param {number} heightCm - 환자 키 (cm)
 * @param {Array} landmarks - MediaPipe 33개 랜드마크 (normalized 0~1)
 * @param {number} aspectRatio - 영상 가로/세로 비율 (예: 16/9 = 1.778)
 * @returns {object|null} 캘리브레이션 결과
 */
export function calibrate(heightCm, landmarks, aspectRatio = 16 / 9) {
  if (!heightCm || !landmarks || landmarks.length < 33) return null;

  const height = parseFloat(heightCm);
  if (isNaN(height) || height <= 0) return null;

  // 전신 높이 측정: 머리 꼭대기 ~ 발끝
  // 머리 꼭대기는 코(0)에서 위로 추정, 발끝은 31/32 사용
  const nose = landmarks[0];
  const lShoulder = landmarks[11], rShoulder = landmarks[12];
  const lElbow = landmarks[13], rElbow = landmarks[14];
  const lWrist = landmarks[15], rWrist = landmarks[16];
  const lIndex = landmarks[19], rIndex = landmarks[20];
  const lHip = landmarks[23], rHip = landmarks[24];
  const lKnee = landmarks[25], rKnee = landmarks[26];
  const lAnkle = landmarks[27], rAnkle = landmarks[28];
  const lFoot = landmarks[31], rFoot = landmarks[32];

  // 머리 꼭대기 추정: 코 위치에서 코~어깨 거리의 약 60%를 위로 올림
  const shoulderY = (lShoulder.y + rShoulder.y) / 2;
  const noseToShoulder = shoulderY - nose.y;
  const headTopY = nose.y - noseToShoulder * 0.6;

  // 발끝 (31, 32번 랜드마크 사용, 없으면 발목 사용)
  const footY = Math.max(
    lFoot.y || lAnkle.y,
    rFoot.y || rAnkle.y
  );

  // 전신 높이 (정규화 좌표)
  const fullHeightNorm = footY - headTopY;

  if (fullHeightNorm <= 0.05) return null; // 너무 작으면 감지 실패

  // ── 스케일 팩터 계산 ──
  // Y축: cm per normalized unit
  const scaleY = height / fullHeightNorm;
  // X축: 종횡비 보정 (정규화 좌표에서 x=1은 영상 가로 전체, y=1은 세로 전체)
  const scaleX = scaleY / aspectRatio;

  // ── 각 신체 부위 실측 ──
  const segments = {};

  // 어깨 너비
  const shoulderWidthNorm = Math.hypot(
    (rShoulder.x - lShoulder.x) * aspectRatio,
    rShoulder.y - lShoulder.y
  );
  segments.shoulderWidth = shoulderWidthNorm * scaleY;

  // 몸통 (어깨 중간 ~ 엉덩이 중간)
  const shoulderMidY = (lShoulder.y + rShoulder.y) / 2;
  const hipMidY = (lHip.y + rHip.y) / 2;
  segments.torso = Math.abs(hipMidY - shoulderMidY) * scaleY;

  // 상완 (어깨 ~ 팔꿈치) - 좌/우 평균
  const lUpperArm = Math.hypot(
    (lElbow.x - lShoulder.x) * aspectRatio,
    lElbow.y - lShoulder.y
  ) * scaleY;
  const rUpperArm = Math.hypot(
    (rElbow.x - rShoulder.x) * aspectRatio,
    rElbow.y - rShoulder.y
  ) * scaleY;
  segments.upperArm = (lUpperArm + rUpperArm) / 2;

  // 전완 (팔꿈치 ~ 손목) - 좌/우 평균
  const lForearm = Math.hypot(
    (lWrist.x - lElbow.x) * aspectRatio,
    lWrist.y - lElbow.y
  ) * scaleY;
  const rForearm = Math.hypot(
    (rWrist.x - rElbow.x) * aspectRatio,
    rWrist.y - rElbow.y
  ) * scaleY;
  segments.forearm = (lForearm + rForearm) / 2;

  // 전체 팔 (어깨 ~ 손목)
  segments.fullArm = segments.upperArm + segments.forearm;

  // 손 (손목 ~ 검지끝)
  const lHand = Math.hypot(
    (lIndex.x - lWrist.x) * aspectRatio,
    lIndex.y - lWrist.y
  ) * scaleY;
  const rHand = Math.hypot(
    (rIndex.x - rWrist.x) * aspectRatio,
    rIndex.y - rWrist.y
  ) * scaleY;
  segments.hand = (lHand + rHand) / 2;

  // 대퇴 (엉덩이 ~ 무릎) - 좌/우 평균
  const lThigh = Math.hypot(
    (lKnee.x - lHip.x) * aspectRatio,
    lKnee.y - lHip.y
  ) * scaleY;
  const rThigh = Math.hypot(
    (rKnee.x - rHip.x) * aspectRatio,
    rKnee.y - rHip.y
  ) * scaleY;
  segments.thigh = (lThigh + rThigh) / 2;

  // 하퇴 (무릎 ~ 발목) - 좌/우 평균
  const lShin = Math.hypot(
    (lAnkle.x - lKnee.x) * aspectRatio,
    lAnkle.y - lKnee.y
  ) * scaleY;
  const rShin = Math.hypot(
    (rAnkle.x - rKnee.x) * aspectRatio,
    rAnkle.y - rKnee.y
  ) * scaleY;
  segments.shin = (lShin + rShin) / 2;

  // 전체 다리
  segments.fullLeg = segments.thigh + segments.shin;

  calibrationData = {
    heightCm: height,
    fullHeightNorm,
    scaleX,
    scaleY,
    aspectRatio,
    segments,
    timestamp: Date.now(),
  };

  return calibrationData;
}

/**
 * 현재 캘리브레이션 데이터 반환
 */
export function getCalibration() {
  return calibrationData;
}

/**
 * 캘리브레이션 완료 여부
 */
export function isCalibrated() {
  return calibrationData !== null;
}

/**
 * 정규화 좌표 거리 → cm 변환 (두 점 사이 실제 거리)
 *
 * @param {object} p1 - {x, y} 정규화 좌표
 * @param {object} p2 - {x, y} 정규화 좌표
 * @returns {number} cm 단위 거리, 미캘리브 시 0
 */
export function distanceCm(p1, p2) {
  if (!calibrationData) return 0;
  const { scaleY, aspectRatio } = calibrationData;
  const dx = (p2.x - p1.x) * aspectRatio;
  const dy = p2.y - p1.y;
  return Math.hypot(dx, dy) * scaleY;
}

/**
 * X축 변위 → cm 변환 (수평 이동 거리)
 *
 * @param {number} dx - 정규화 x좌표 변위
 * @returns {number} cm 단위
 */
export function horizontalCm(dx) {
  if (!calibrationData) return 0;
  return Math.abs(dx) * calibrationData.aspectRatio * calibrationData.scaleY;
}

/**
 * Y축 변위 → cm 변환 (수직 이동 거리)
 *
 * @param {number} dy - 정규화 y좌표 변위
 * @returns {number} cm 단위
 */
export function verticalCm(dy) {
  if (!calibrationData) return 0;
  return Math.abs(dy) * calibrationData.scaleY;
}
