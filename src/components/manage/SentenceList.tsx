import React, { memo, useState, useEffect, useCallback, useMemo } from 'react';
import { List, RowComponentProps } from 'react-window';
import { Sentence } from '../../types';
import { getSafeTags } from '../../utils/format';

type TTSEngine = 'elevenlabs' | 'minimax';

interface SentenceListProps {
  sentences: Sentence[];
  onDeleteAudio?: (sentence: Sentence) => void;
  onGenerateAudio?: (sentence: Sentence, engine: TTSEngine) => void;
  onEdit?: (sentence: Sentence, english: string, chinese: string, tags: string[]) => void;
}

const hasAudioCache = (s: Sentence): boolean => {
  return !!(s.ttsAudioPathEl || s.ttsAudioPathMm);
};

const getAudioEngineLabel = (s: Sentence): string | null => {
  const parts: string[] = [];
  if (s.ttsAudioPathEl) parts.push('ElevenLabs');
  if (s.ttsAudioPathMm) parts.push('MiniMax');
  return parts.length > 0 ? parts.join(' / ') : null;
};

/** 普通模式行高 */
const NORMAL_ROW_HEIGHT = 300;
/** 编辑模式行高 */
const EDIT_ROW_HEIGHT = 420;

/** 传递给每行组件的额外 props */
interface RowData {
  sentences: Sentence[];
  editingId: string | null;
  editEn: string;
  editZh: string;
  editTags: string;
  audioDeleteConfirmId: string | null;
  generatingAudioId: string | null;
  generatingEngine: TTSEngine | null;
  enginePopupId: string | null;
  onEdit: SentenceListProps['onEdit'];
  onDeleteAudio: SentenceListProps['onDeleteAudio'];
  onGenerateAudio: SentenceListProps['onGenerateAudio'];
  setEditEn: (v: string) => void;
  setEditZh: (v: string) => void;
  setEditTags: (v: string) => void;
  startEditing: (s: Sentence) => void;
  cancelEditing: () => void;
  handleSaveEdit: (s: Sentence) => void;
  handleAudioDeleteClick: (s: Sentence) => void;
  handleGenerateClick: (engine: TTSEngine, s: Sentence) => void;
  toggleEnginePopup: (id: string) => void;
}

/** 虚拟列表中每行的渲染组件 */
const SentenceRow = memo(({ index, style, ...data }: RowComponentProps<RowData>) => {
  const {
    sentences, editingId, editEn, editZh, editTags,
    audioDeleteConfirmId, generatingAudioId, generatingEngine, enginePopupId,
    onEdit, onDeleteAudio, onGenerateAudio,
    setEditEn, setEditZh, setEditTags,
    startEditing, cancelEditing, handleSaveEdit,
    handleAudioDeleteClick, handleGenerateClick, toggleEnginePopup,
  } = data;

  const s = sentences[index];
  if (!s) return null;
  const isEditing = editingId === s.id;
  const enChanged = isEditing && editEn.trim() !== s.english;

  return (
    <div style={style}>
      <div className="px-2 pb-4">
        <div className="apple-card p-8 group relative hover:border-blue-100/50 transition-all">
          {isEditing ? (
            <>
              <div className="space-y-3 mb-4">
                <textarea
                  value={editEn}
                  onChange={e => setEditEn(e.target.value)}
                  className="w-full p-3 border border-blue-200 rounded-xl text-lg font-black text-gray-900 leading-tight resize-none focus:outline-none focus:border-blue-400 bg-white"
                  rows={2}
                  placeholder="英文句子"
                />
                <textarea
                  value={editZh}
                  onChange={e => setEditZh(e.target.value)}
                  className="w-full p-3 border border-gray-200 rounded-xl text-sm text-gray-600 font-medium resize-none focus:outline-none focus:border-blue-400 bg-white"
                  rows={2}
                  placeholder="中文翻译"
                />
                <input
                  value={editTags}
                  onChange={e => setEditTags(e.target.value)}
                  className="w-full p-2 border border-gray-200 rounded-xl text-[10px] font-bold text-gray-600 focus:outline-none focus:border-blue-400 bg-white"
                  placeholder="标签（逗号分隔）"
                />
              </div>
              {enChanged && (
                <div className="mb-4 px-3 py-2 bg-amber-50 border border-amber-200 rounded-xl">
                  <span className="text-[10px] font-bold text-amber-700">⚠️ 英文有变更，语音缓存将被清除</span>
                </div>
              )}
              <div className="flex items-center gap-3">
                <button
                  onClick={() => handleSaveEdit(s)}
                  disabled={!editEn.trim()}
                  className="px-4 py-2 bg-blue-500 text-white rounded-xl text-xs font-black hover:bg-blue-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  ✅ 保存
                </button>
                <button
                  onClick={cancelEditing}
                  className="px-4 py-2 bg-gray-100 text-gray-600 rounded-xl text-xs font-bold hover:bg-gray-200 transition-colors"
                >
                  ❌ 取消
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="flex justify-between items-start mb-4">
                <div className="flex-1 pr-10">
                  <p className="text-lg font-black text-gray-900 leading-tight mb-2">{s.english}</p>
                  <p className="text-sm text-gray-600 font-medium italic">{s.chinese}</p>
                </div>
                {onEdit && (
                  <button
                    onClick={() => startEditing(s)}
                    className="w-8 h-8 flex items-center justify-center text-gray-400 hover:text-blue-500 transition-all"
                    title="编辑句子"
                  >
                    ✏️
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-2 mb-4">
                {getSafeTags(s.tags).map(tag => (
                  <span key={tag} className="px-3 py-1 bg-gray-100 text-gray-600 rounded-full text-[10px] font-black uppercase tracking-widest">{tag}</span>
                ))}
                {s.scheduledDate && (
                  <span
                    className="px-3 py-1 bg-emerald-100 text-emerald-700 rounded-full text-[10px] font-black uppercase tracking-widest flex items-center gap-1"
                    title={`预约日期 ${String(s.scheduledDate)}`}
                  >
                    📅 预约 {String(s.scheduledDate).replace(/^(\d{4})-(\d{2})-(\d{2})$/, (_, m, d) => `${parseInt(m, 10)}月${parseInt(d, 10)}日`)}
                  </span>
                )}
              </div>
              {onDeleteAudio && (
                <div className="flex items-center justify-between mb-4 px-3 py-2 bg-gray-50 rounded-xl">
                  <div className="flex items-center gap-2">
                    {generatingAudioId === s.id ? (
                      <>
                        <span className="text-[10px]">⏳</span>
                        <span className="text-[10px] font-bold text-amber-700">
                          {generatingEngine === 'elevenlabs' ? 'ElevenLabs' : 'MiniMax'} 生成中...
                        </span>
                      </>
                    ) : hasAudioCache(s) ? (
                      <>
                        <span className="text-[10px] text-green-600">🔊</span>
                        <span className="text-[10px] font-bold text-green-700">
                          {getAudioEngineLabel(s)}
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="text-[10px] text-gray-400">🔇</span>
                        <span className="text-[10px] text-gray-400">无语音缓存</span>
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-2 relative">
                    {generatingAudioId === s.id ? null : onGenerateAudio ? (
                      <>
                        {hasAudioCache(s) && (
                          <button
                            onClick={() => handleAudioDeleteClick(s)}
                            className={`text-[10px] font-bold transition-colors ${
                              audioDeleteConfirmId === s.id
                                ? 'text-red-500'
                                : 'text-gray-500 hover:text-red-500'
                            }`}
                            title={audioDeleteConfirmId === s.id ? '再次点击确认清除' : '清除语音缓存'}
                          >
                            {audioDeleteConfirmId === s.id ? '⚠️ 确认清除?' : '🗑️ 清除语音'}
                          </button>
                        )}
                        <button
                          onClick={() => toggleEnginePopup(s.id)}
                          className="text-[10px] font-bold text-gray-500 hover:text-blue-600 transition-colors"
                          title={hasAudioCache(s) ? '重新生成语音' : '生成语音'}
                        >
                          {hasAudioCache(s) ? '🔄 重新生成' : '🔊 生成语音'}
                        </button>
                        {enginePopupId === s.id && (
                          <div className="absolute top-full right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-10 py-1 min-w-[110px]">
                            <button
                              onClick={() => handleGenerateClick('elevenlabs', s)}
                              className="w-full text-left px-3 py-1.5 text-[10px] font-bold text-gray-700 hover:bg-blue-50 hover:text-blue-700 transition-colors"
                            >
                              🎙️ ElevenLabs
                            </button>
                            <button
                              onClick={() => handleGenerateClick('minimax', s)}
                              className="w-full text-left px-3 py-1.5 text-[10px] font-bold text-gray-700 hover:bg-purple-50 hover:text-purple-700 transition-colors"
                            >
                              🎙️ MiniMax
                            </button>
                          </div>
                        )}
                      </>
                    ) : (
                      hasAudioCache(s) && (
                        <button
                          onClick={() => handleAudioDeleteClick(s)}
                          className={`text-[10px] font-bold transition-colors ${
                            audioDeleteConfirmId === s.id
                              ? 'text-red-500'
                              : 'text-gray-500 hover:text-red-500'
                          }`}
                          title={audioDeleteConfirmId === s.id ? '再次点击确认清除' : '清除语音缓存'}
                        >
                          {audioDeleteConfirmId === s.id ? '⚠️ 确认清除?' : '🗑️ 清除语音'}
                        </button>
                      )
                    )}
                  </div>
                </div>
              )}
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
            </>
          )}
        </div>
      </div>
    </div>
  );
});

export const SentenceList: React.FC<SentenceListProps> = memo(({ sentences, onDeleteAudio, onGenerateAudio, onEdit }) => {
  const [audioDeleteConfirmId, setAudioDeleteConfirmId] = useState<string | null>(null);
  const [generatingAudioId, setGeneratingAudioId] = useState<string | null>(null);
  const [generatingEngine, setGeneratingEngine] = useState<TTSEngine | null>(null);
  const [enginePopupId, setEnginePopupId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editEn, setEditEn] = useState('');
  const [editZh, setEditZh] = useState('');
  const [editTags, setEditTags] = useState('');

  useEffect(() => {
    if (audioDeleteConfirmId) {
      const timer = setTimeout(() => setAudioDeleteConfirmId(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [audioDeleteConfirmId]);

  useEffect(() => {
    if (enginePopupId) {
      const timer = setTimeout(() => setEnginePopupId(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [enginePopupId]);

  useEffect(() => {
    if (!generatingAudioId) return;
    const sentence = sentences.find(s => s.id === generatingAudioId);
    if (sentence && hasAudioCache(sentence)) {
      setGeneratingAudioId(null);
      setGeneratingEngine(null);
      return;
    }
    const timeout = setTimeout(() => {
      setGeneratingAudioId(null);
      setGeneratingEngine(null);
    }, 30000);
    return () => clearTimeout(timeout);
  }, [sentences, generatingAudioId]);

  const handleAudioDeleteClick = (s: Sentence) => {
    if (audioDeleteConfirmId === s.id) {
      onDeleteAudio?.(s);
      setAudioDeleteConfirmId(null);
    } else {
      setAudioDeleteConfirmId(s.id);
    }
  };

  const handleGenerateClick = (engine: TTSEngine, s: Sentence) => {
    setEnginePopupId(null);
    setGeneratingAudioId(s.id);
    setGeneratingEngine(engine);
    onGenerateAudio?.(s, engine);
  };

  const toggleEnginePopup = (id: string) => {
    setEnginePopupId(prev => prev === id ? null : id);
  };

  const startEditing = (s: Sentence) => {
    setEditingId(s.id);
    setEditEn(s.english);
    setEditZh(s.chinese);
    setEditTags((s.tags || []).join(', '));
    setEnginePopupId(null);
    setAudioDeleteConfirmId(null);
  };

  const cancelEditing = () => {
    setEditingId(null);
    setEditEn('');
    setEditZh('');
    setEditTags('');
  };

  const handleSaveEdit = (s: Sentence) => {
    const trimmedEn = editEn.trim();
    if (!trimmedEn) return;
    const tags = getSafeTags(editTags);
    onEdit?.(s, trimmedEn, editZh.trim(), tags);
    setEditingId(null);
  };

  /** 构建 rowProps，sentences 引用变化时整个对象更新，触发 List 重渲染 */
  const rowProps: RowData = useMemo(() => ({
    sentences,
    editingId, editEn, editZh, editTags,
    audioDeleteConfirmId, generatingAudioId, generatingEngine, enginePopupId,
    onEdit, onDeleteAudio, onGenerateAudio,
    setEditEn, setEditZh, setEditTags,
    startEditing, cancelEditing, handleSaveEdit,
    handleAudioDeleteClick, handleGenerateClick, toggleEnginePopup,
  }), [
    sentences,
    editingId, editEn, editZh, editTags,
    audioDeleteConfirmId, generatingAudioId, generatingEngine, enginePopupId,
    onEdit, onDeleteAudio, onGenerateAudio,
  ]);

  /** 动态行高：编辑中的行用更大的高度 */
  const getRowHeight = useCallback((index: number, _rowProps: RowData) => {
    return _rowProps.sentences[index]?.id === _rowProps.editingId ? EDIT_ROW_HEIGHT : NORMAL_ROW_HEIGHT;
  }, []);

  if (sentences.length === 0) {
    return (
      <div className="p-20 text-center opacity-50 text-xs font-black uppercase tracking-widest">No entries found</div>
    );
  }

  return (
    <div className="pb-20">
      <List
        rowComponent={SentenceRow as any}
        rowCount={sentences.length}
        rowHeight={getRowHeight}
        rowProps={rowProps}
        overscanCount={3}
        style={{ height: 'calc(100dvh - 280px)', minHeight: '400px' }}
      />
    </div>
  );
});