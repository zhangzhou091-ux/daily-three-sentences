import React from 'react';
import { Sentence } from '../../../types';

interface ReviewCardProps {
  sentence: Sentence;
  onFlip: () => void;
  isFlipped: boolean;
  onSpeak: (text: string, loop?: boolean) => void;
  scheduledDays?: number;
  reps?: number;
  isSpeaking: boolean;
  speechRate: number;
  onSpeechRateChange: (rate: number) => void;
}

const SPEECH_RATE_OPTIONS = [
  { value: 0.2, label: '0.2x' },
  { value: 0.5, label: '0.5x' },
  { value: 1, label: '1x' },
];

export const ReviewCard: React.FC<ReviewCardProps> = ({
  sentence,
  onFlip,
  isFlipped,
  onSpeak,
  scheduledDays,
  reps = 0,
  isSpeaking,
  speechRate,
  onSpeechRateChange,
}) => {
  return (
    <div className="perspective-1000 min-h-[380px] w-full">
      <div
        className={`card-inner apple-card ${isFlipped ? 'card-flipped' : ''}`}
        onClick={onFlip}
        style={{ position: 'relative', width: '100%', height: 'auto', transformStyle: 'preserve-3d' }}
      >
        <div
          className="card-front p-6 bg-white"
          style={{
            backfaceVisibility: 'hidden',
            WebkitBackfaceVisibility: 'hidden',
            transform: 'translateZ(1px)',
            position: 'relative',
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            justifyContent: 'flex-start',
            minHeight: '380px',
            textAlign: 'left',
            paddingTop: '20px',
            paddingBottom: '20px',
            overflow: 'hidden'
          }}
        >
          <div className="w-full flex items-center justify-between mb-3" onClick={(e) => e.stopPropagation()}>
            <p className="text-xs font-black text-gray-600 uppercase tracking-[0.2em]">已复习 {reps} 次</p>
            <div className="flex items-center gap-1">
              {SPEECH_RATE_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => onSpeechRateChange(opt.value)}
                  className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold transition-all ${
                    speechRate === opt.value
                      ? 'bg-blue-500 text-white shadow-sm'
                      : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <div className="flex flex-col items-end bg-white px-2 py-1 rounded-lg shadow-sm">
              <span className="text-[8px] font-black text-blue-500 uppercase tracking-widest mb-0.5">下次复习</span>
              <span className="text-xs font-bold text-gray-700">
                {scheduledDays
                  ? scheduledDays === 1
                    ? '明天'
                  : `${scheduledDays}天后`
                : '待定'}
              </span>
            </div>
          </div>

          <div className="mt-[2em] flex flex-col items-center w-full flex-1 overflow-y-auto min-h-0">
            <h3 className="text-lg font-normal text-gray-900 w-full leading-normal mt-0 break-words whitespace-pre-wrap text-left m-0 p-0">
              {sentence.english}
            </h3>

            <div className="mt-auto flex flex-col items-center">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onSpeak(sentence.english, true);
                }}
                className={`w-16 h-16 rounded-full flex items-center justify-center text-2xl transition-all z-20 ${
                  isSpeaking
                    ? 'bg-red-50 text-red-500 hover:scale-110 active:scale-95 animate-pulse'
                    : 'bg-blue-50 text-blue-600 hover:scale-110 active:scale-95'
                }`}
              >
                {isSpeaking ? '⏹' : '🔊'}
              </button>

              <p className="text-xs font-black text-gray-600 uppercase tracking-widest mt-6">点击翻转查看翻译</p>
            </div>
          </div>
        </div>

        <div
          className="card-back p-6 flex flex-col bg-white"
          style={{
            backfaceVisibility: 'hidden',
            WebkitBackfaceVisibility: 'hidden',
            position: 'absolute',
            inset: 0,
            transform: 'rotateY(180deg) translateZ(1px)',
            textAlign: 'left',
            paddingTop: '20px',
            paddingBottom: '20px'
          }}
        >
          <div className="w-full flex items-center justify-between mb-3 opacity-0 pointer-events-none">
            <p className="text-xs font-black uppercase tracking-[0.2em]">占位</p>
            <div className="flex items-center gap-1">
              {SPEECH_RATE_OPTIONS.map(opt => (
                <span key={opt.value} className="px-2.5 py-0.5 text-[10px]">{opt.label}</span>
              ))}
            </div>
            <div className="px-2 py-1">占位</div>
          </div>

          <div className="flex-1 flex items-start justify-start overflow-y-auto pr-2 min-h-0">
            <h4 className="text-lg font-normal text-gray-900 leading-normal w-full break-words whitespace-pre-wrap text-left m-0 p-0">
              {sentence.chinese}
            </h4>
          </div>

          <div className="flex flex-col items-center mt-4">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onSpeak(sentence.english, true);
              }}
              className={`w-16 h-16 rounded-full flex items-center justify-center text-2xl transition-all z-20 ${
                isSpeaking
                  ? 'bg-red-50 text-red-500 hover:scale-110 active:scale-95 animate-pulse'
                  : 'bg-blue-50 text-blue-600 hover:scale-110 active:scale-95'
              }`}
            >
              {isSpeaking ? '⏹' : '🔊'}
            </button>
          </div>

          <div className="flex-shrink-0 flex justify-center mt-4">
            <div className="bg-blue-50 text-blue-500 px-6 py-2 rounded-full text-xs font-black uppercase tracking-[0.2em]">
              可理解输入，举一反三，场景运用
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
