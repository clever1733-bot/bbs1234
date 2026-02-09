import { useRef, useState } from 'react';

function VideoUploadField({
  label,
  description,
  file,
  videoUrl,
  onFileSelect,
  onRemove,
  accentColor = 'emerald',
  icon,
}) {
  const fileInputRef = useRef(null);
  const [duration, setDuration] = useState(0);

  const colorMap = {
    emerald: {
      border: 'hover:border-emerald-500/50',
      iconBg: 'bg-emerald-500/20',
      iconText: 'text-emerald-400',
      groupIcon: 'group-hover:bg-emerald-500/20',
      groupText: 'group-hover:text-emerald-400',
    },
    blue: {
      border: 'hover:border-blue-500/50',
      iconBg: 'bg-blue-500/20',
      iconText: 'text-blue-400',
      groupIcon: 'group-hover:bg-blue-500/20',
      groupText: 'group-hover:text-blue-400',
    },
    purple: {
      border: 'hover:border-purple-500/50',
      iconBg: 'bg-purple-500/20',
      iconText: 'text-purple-400',
      groupIcon: 'group-hover:bg-purple-500/20',
      groupText: 'group-hover:text-purple-400',
    },
  };

  const colors = colorMap[accentColor] || colorMap.emerald;

  const handleFileChange = (e) => {
    const f = e.target.files[0];
    if (f && f.type.startsWith('video/')) {
      onFileSelect(f);
    }
  };

  const handleLoadedMetadata = (e) => {
    setDuration(e.target.duration);
  };

  return (
    <div className="flex-1">
      <div className="flex items-center gap-2 mb-3">
        {icon && (
          <div className={`w-8 h-8 ${colors.iconBg} rounded-lg flex items-center justify-center`}>
            <span className={`text-sm ${colors.iconText}`}>{icon}</span>
          </div>
        )}
        <div>
          <h4 className="text-white font-medium text-sm">{label}</h4>
          {description && (
            <p className="text-slate-500 text-xs">{description}</p>
          )}
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="video/*"
        onChange={handleFileChange}
        className="hidden"
      />

      {!file ? (
        <button
          onClick={() => fileInputRef.current?.click()}
          className={`w-full p-6 border-2 border-dashed border-slate-700 rounded-xl ${colors.border} hover:bg-slate-800/30 transition-all group`}
        >
          <div className="text-center">
            <div className={`w-12 h-12 bg-slate-800 rounded-full flex items-center justify-center mx-auto mb-3 ${colors.groupIcon} transition-colors`}>
              <svg className={`w-6 h-6 text-slate-500 ${colors.groupText} transition-colors`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
            </div>
            <p className="text-slate-400 text-sm mb-1">클릭하여 영상 선택</p>
            <p className="text-slate-500 text-xs">MP4, MOV, AVI</p>
          </div>
        </button>
      ) : (
        <div className="space-y-3">
          <div className="aspect-video bg-slate-800 rounded-xl overflow-hidden">
            <video
              src={videoUrl}
              className="w-full h-full object-contain"
              onLoadedMetadata={handleLoadedMetadata}
              controls
            />
          </div>
          <div className="flex items-center justify-between p-2.5 bg-slate-800/50 rounded-lg">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className={`w-8 h-8 ${colors.iconBg} rounded-lg flex items-center justify-center shrink-0`}>
                <svg className={`w-4 h-4 ${colors.iconText}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </div>
              <div className="min-w-0">
                <p className="text-white text-xs font-medium truncate">{file.name}</p>
                <p className="text-slate-500 text-xs">
                  {(file.size / 1024 / 1024).toFixed(1)} MB
                  {duration > 0 && ` · ${Math.floor(duration)}초`}
                </p>
              </div>
            </div>
            <button
              onClick={onRemove}
              className="text-slate-400 hover:text-red-400 transition-colors shrink-0 ml-2"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default VideoUploadField;
