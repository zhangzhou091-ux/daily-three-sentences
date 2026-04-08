import React, { memo, useState, useEffect } from 'react';
import { Sentence } from '../../types';
import { getSafeTags } from '../../utils/format';

interface SentenceListProps {
  sentences: Sentence[];
  onDelete: (id: string) => void;
}

export const SentenceList: React.FC<SentenceListProps> = memo(({ sentences, onDelete }) => {
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  useEffect(() => {
    if (deleteConfirmId) {
      const timer = setTimeout(() => {
        setDeleteConfirmId(null);
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [deleteConfirmId]);

  const handleDeleteClick = (id: string) => {
    if (deleteConfirmId === id) {
      onDelete(id);
      setDeleteConfirmId(null);
    } else {
      setDeleteConfirmId(id);
    }
  };

  if (sentences.length === 0) {
    return (
      <div className="p-20 text-center opacity-50 text-xs font-black uppercase tracking-widest">No entries found</div>
    );
  }

  return (
    <div className="space-y-4 pb-20">
      {sentences.map(s => (
        <div key={s.id} className="apple-card p-8 group relative hover:border-blue-100/50 transition-all">
          <div className="flex justify-between items-start mb-4">
            <div className="flex-1 pr-10">
              <p className="text-lg font-black text-gray-900 leading-tight mb-2">{s.english}</p>
              <p className="text-sm text-gray-600 font-medium italic">{s.chinese}</p>
            </div>
            <button 
              onClick={() => handleDeleteClick(s.id)} 
              className={`w-8 h-8 flex items-center justify-center transition-all ${
                deleteConfirmId === s.id 
                  ? 'text-red-500 opacity-100' 
                  : 'text-gray-600 opacity-0 group-hover:opacity-100'
              }`}
              title={deleteConfirmId === s.id ? '再次点击确认删除' : '删除'}
            >
              {deleteConfirmId === s.id ? '确认?' : '✕'}
            </button>
          </div>
          <div className="flex flex-wrap gap-2 mb-6">
            {getSafeTags(s.tags).map(tag => (
              <span key={tag} className="px-3 py-1 bg-gray-100 text-gray-600 rounded-full text-[10px] font-black uppercase tracking-widest">{tag}</span>
            ))}
          </div>
          <div className="flex items-center justify-between pt-6 border-t border-black/[0.03]">
            <div className="flex gap-1">
              {[...Array(10)].map((_, i) => (
                <div key={i} className={`w-1.5 h-1.5 rounded-full ${i < s.intervalIndex ? 'bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.5)]' : 'bg-gray-200'}`} />
              ))}
            </div>
            <span className="text-[10px] font-black text-gray-600 uppercase tracking-[0.2em]">
              {s.intervalIndex >= 9 ? 'MASTERED' : `STAGE ${s.intervalIndex}`}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
});
