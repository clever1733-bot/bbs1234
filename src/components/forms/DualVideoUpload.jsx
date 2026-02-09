import { Card } from '../ui';
import VideoUploadField from './VideoUploadField';

function DualVideoUpload({
  sideFile,
  sideUrl,
  onSideSelect,
  onSideRemove,
  frontFile,
  frontUrl,
  onFrontSelect,
  onFrontRemove,
  accentColor = 'emerald',
}) {
  return (
    <Card padding="md">
      <h3 className="text-white font-semibold mb-5">검사 영상 업로드</h3>

      <div className="grid md:grid-cols-2 gap-5">
        <VideoUploadField
          label="측면 영상"
          description="환자의 옆모습이 보이도록 촬영"
          icon="측"
          file={sideFile}
          videoUrl={sideUrl}
          onFileSelect={onSideSelect}
          onRemove={onSideRemove}
          accentColor={accentColor}
        />
        <VideoUploadField
          label="정면 영상"
          description="환자의 앞모습이 보이도록 촬영"
          icon="정"
          file={frontFile}
          videoUrl={frontUrl}
          onFileSelect={onFrontSelect}
          onRemove={onFrontRemove}
          accentColor={accentColor}
        />
      </div>

      <div className="mt-4 flex items-start gap-2 p-3 bg-slate-800/50 rounded-lg">
        <svg className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p className="text-slate-400 text-xs leading-relaxed">
          측면과 정면 영상을 모두 업로드하면 더 정확한 분석이 가능합니다.
          최소 한 개 이상의 영상을 업로드해 주세요.
        </p>
      </div>
    </Card>
  );
}

export default DualVideoUpload;
