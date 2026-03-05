import React from 'react';
import { DictationRecord, Sentence } from '../../../types';

interface DictationResultProps {
  dictationList: DictationRecord[];
  sentences: Sentence[];
}

export const DictationResult: React.FC<DictationResultProps> = ({ dictationList, sentences }) => {
  return (
    <div className="space-y-4 pb-10">
      <h4 className="text-[11px] font-black text-gray-400 uppercase tracking-widest ml-4">
        今日成果 ({dictationList.length})
      </h4>
      <div className="space-y-3">
        {dictationList.map((item, idx) => {
          const s = sentences.find(sent => sent.id === item.sentenceId);
          if (!s) return null;
          return (
            <div key={idx} className="apple-card p-5 flex items-center justify-between group bg-white/60 hover:bg-white transition-all">
              <div className="flex-1 pr-4">
                <p className="text-sm font-bold text-gray-800 line-clamp-1">{s.english}</p>
                <p className="text-[10px] text-gray-400 font-medium">{s.chinese}</p>
              </div>
              <div className={`w-8 h-8 rounded-full flex items-center justify-center font-black ${
                item.status === 'correct' ? 'bg-green-100 text-green-600' : 'bg-red-50 text-red-400'
              }`}>
                {item.status === 'correct' ? '✓' : '×'}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
