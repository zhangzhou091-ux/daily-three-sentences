import React from 'react';
import { Sentence } from '../../../types';

interface LearnCardProps {
  sentence: Sentence;
  onFlip: () => void;
  isFlipped: boolean;
  onMarkLearned: (id: string) => void;
  onSpeak: (text: string) => void;
  isCurrentlyLearned: boolean;
  isAnimating: boolean;
  isSavingLearned: boolean;
}

export const LearnCard: React.FC<LearnCardProps> = ({
  sentence,
  onFlip,
  isFlipped,
  onMarkLearned,
  onSpeak,
  isCurrentlyLearned,
  isAnimating,
  isSavingLearned
}) => {
  return (
    <div className="perspective-1000 min-h-[340px] w-full">
      <div
        className={`card-inner apple-card ${isFlipped ? 'card-flipped' : ''}`}
        onClick={onFlip}
        style={{ position: 'relative', width: '100%', height: 'auto', transformStyle: 'preserve-3d' }}
      >
        <div
          className="card-front p-6 transition-all duration-700 bg-white"
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
            minHeight: '340px',
            textAlign: 'left',
            paddingTop: '20px',
            paddingBottom: '20px',
            overflow: 'hidden'
          }}
        >
          {(isCurrentlyLearned || isAnimating) && (
            <div className="bg-green-100 text-green-600 text-xs font-black px-4 py-1.5 rounded-full mb-4 flex items-center gap-2 shadow-sm border border-green-200/50">
              <span className="w-1.5 h-1.5 bg-green-500 rounded-full"></span>
              已进入计划
            </div>
          )}

          <div className="mt-[2em] flex flex-col items-center w-full flex-1 overflow-y-auto min-h-0">
            <h3 className="text-lg font-normal text-gray-900 leading-normal w-full break-words whitespace-pre-wrap text-left m-0 p-0">
              {sentence.english}
            </h3>

            <div className="mt-auto flex flex-col items-center">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onSpeak(sentence.english);
                }}
                className="w-16 h-16 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center text-2xl hover:scale-110 active:scale-95 transition-all z-20"
              >
                🔊
              </button>

              <p className="text-xs font-black text-gray-600 uppercase tracking-widest mt-6">点击卡片翻转显示中文</p>
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
          <div className="flex-shrink-0">
            {(isCurrentlyLearned || isAnimating) && (
              <div className="opacity-0 mb-4 pointer-events-none">占位</div>
            )}
          </div>

          <div className="flex-1 flex items-start justify-start overflow-y-auto pr-2 min-h-0">
            <p className="text-lg text-gray-800 font-normal leading-normal w-full break-words whitespace-pre-wrap text-left m-0 p-0">
              {sentence.chinese}
            </p>
          </div>

          <div className="flex-shrink-0 flex justify-center mt-4">
            <div className="px-6 py-2 bg-gray-100 rounded-full text-xs font-black text-gray-600 uppercase tracking-widest">
              可理解输入，举一反三，场景运用
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
