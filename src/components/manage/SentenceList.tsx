import React, { memo } from 'react';
import { Sentence } from '../../types';

interface SentenceListProps {
  sentences: Sentence[];
  onDelete: (id: string) => void;
  getSafeTags: (tags: unknown) => string[];
}

export const SentenceList: React.FC<SentenceListProps> = memo(({ sentences, onDelete, getSafeTags }) => {
  if (sentences.length === 0) {
    return (
      <div className="p-20 text-center opacity-30 text-xs font-black uppercase tracking-widest">No entries found</div>
    );
  }

  return (
    <div className="space-y-4 pb-20">
      {sentences.map(s => (
        <div key={s.id} className="apple-card p-8 group relative hover:border-blue-100/50 transition-all">
          <div className="flex justify-between items-start mb-4">
            <div className="flex-1 pr-10">
              <p className="text-lg font-black text-gray-900 leading-tight mb-2">{s.english}</p>
              <p className="text-sm text-gray-500 font-medium italic">{s.chinese}</p>
            </div>
            <button 
              onClick={() => onDelete(s.id)} 
              className="w-8 h-8 flex items-center justify-center text-gray-300 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
            >
              ✕
            </button>
          </div>
          <div className="flex flex-wrap gap-2 mb-6">
            {getSafeTags(s.tags).map(tag => (
              <span key={tag} className="px-3 py-1 bg-gray-50 text-gray-400 rounded-full text-[9px] font-black uppercase tracking-widest">{tag}</span>
            ))}
          </div>
          <div className="flex items-center justify-between pt-6 border-t border-black/[0.03]">
            <div className="flex gap-1">
              {[...Array(10)].map((_, i) => (
                <div key={i} className={`w-1.5 h-1.5 rounded-full ${i < s.intervalIndex ? 'bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.5)]' : 'bg-gray-100'}`} />
              ))}
            </div>
            <span className="text-[9px] font-black text-gray-300 uppercase tracking-[0.2em]">
              {s.intervalIndex >= 9 ? 'MASTERED' : `STAGE ${s.intervalIndex}`}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
});
