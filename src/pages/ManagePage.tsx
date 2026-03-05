import React, { useState, useMemo, useRef, useDeferredValue, useCallback } from 'react';
import { Sentence } from '../types';
import { storageService } from '../services/storage';
import { generateUUID } from '../utils/uuid';
import * as XLSX from 'xlsx';
import { StatisticsSection } from '../components/manage/StatisticsSection';
import { SentenceList } from '../components/manage/SentenceList';

interface ImportProgress {
  total: number;
  processed: number;
  success: number;
  skipped: number;
  errors: Array<{ row: number; message: string }>;
  status: 'idle' | 'validating' | 'importing' | 'done' | 'error';
}

interface ManagePageProps {
  sentences: Sentence[];
  onUpdate: () => Promise<void>;
}

// Helper function to safely parse tags
const getSafeTags = (tags: unknown): string[] => {
  if (Array.isArray(tags)) {
    return tags.filter(tag => typeof tag === 'string' && tag.trim() !== '');
  } else if (typeof tags === 'string') {
    return tags.split(/[，,;；]/).map(t => t.trim()).filter(t => t !== '');
  }
  return [];
};

const ManagePage: React.FC<ManagePageProps> = ({ sentences, onUpdate }) => {
  const [newEn, setNewEn] = useState('');
  const [newZh, setNewZh] = useState('');
  const [newTags, setNewTags] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  // Use deferred value to prevent UI blocking during typing
  const deferredQuery = useDeferredValue(searchQuery);
  
  const [duplicateWarning, setDuplicateWarning] = useState<{ show: boolean; existing?: Sentence }>({ show: false });
  const [importProgress, setImportProgress] = useState<ImportProgress>({
    total: 0,
    processed: 0,
    success: 0,
    skipped: 0,
    errors: [],
    status: 'idle'
  });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addSentence = useCallback(async () => {
    if (!newEn || !newZh) return;
    const tagsArray = getSafeTags(newTags);
    
    const newItem: Sentence = {
      id: generateUUID(),
      english: newEn,
      chinese: newZh,
      addedAt: Date.now(),
      lastReviewedAt: null,
      nextReviewDate: null,
      intervalIndex: 0,
      masteryLevel: 0,
      timesReviewed: 0,
      wrongDictations: 0,
      tags: tagsArray,
      updatedAt: Date.now(),
      isManual: true 
    };
    
    const result = await storageService.addSentence(newItem);
    
    if (!result.success) {
      setDuplicateWarning({ show: true, existing: result.duplicate });
      return;
    }
    
    await onUpdate();
    setNewEn('');
    setNewZh('');
    setNewTags('');
    setDuplicateWarning({ show: false });
  }, [newEn, newZh, newTags, onUpdate]);

  const deleteSentence = useCallback(async (id: string) => {
    if (!window.confirm('确定要从数据库中永久移除这句话吗？')) return;
    await storageService.deleteSentence(id);
    await onUpdate();
  }, [onUpdate]);

  const handleExcelImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const MAX_IMPORT_COUNT = 1000;
    const MAX_ENGLISH_LENGTH = 500;
    const MAX_CHINESE_LENGTH = 200;

    setImportProgress({
      total: 0,
      processed: 0,
      success: 0,
      skipped: 0,
      errors: [],
      status: 'validating'
    });

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const bstr = evt.target?.result;
        const wb = XLSX.read(bstr, { type: 'binary' });
        const wsname = wb.SheetNames[0];
        const ws = wb.Sheets[wsname];
        const data = XLSX.utils.sheet_to_json(ws) as any[];

        if (data.length === 0) {
          setImportProgress(prev => ({
            ...prev,
            status: 'error',
            errors: [{ row: 0, message: 'Excel 文件为空，请检查文件内容。' }]
          }));
          return;
        }

        if (data.length > MAX_IMPORT_COUNT) {
          setImportProgress(prev => ({
            ...prev,
            status: 'error',
            errors: [{ row: 0, message: `单次导入数量不能超过 ${MAX_IMPORT_COUNT} 条，当前有 ${data.length} 条数据。` }]
          }));
          return;
        }

        setImportProgress(prev => ({ ...prev, total: data.length, status: 'importing' }));

        const baseTime = Date.now();
        const newSentences: Sentence[] = [];
        const errors: Array<{ row: number; message: string }> = [];
        let skippedCount = 0;
        const processedEnglish = new Set<string>();

        for (let index = 0; index < data.length; index++) {
          const row = data[index];
          const english = String(row.English || row['英文'] || row.english || row['english'] || '').trim();
          const chinese = String(row.Chinese || row['中文'] || row.chinese || row['chinese'] || '').trim();
          
          if (!english || !chinese) {
            continue;
          }

          if (english.length > MAX_ENGLISH_LENGTH) {
            errors.push({ row: index + 1, message: `英文内容过长（${english.length}字符）` });
            continue;
          }

          if (chinese.length > MAX_CHINESE_LENGTH) {
            errors.push({ row: index + 1, message: `中文内容过长（${chinese.length}字符）` });
            continue;
          }

          const normalizedEnglish = english.toLowerCase();
          if (processedEnglish.has(normalizedEnglish)) {
            skippedCount++;
            continue;
          }

          const existing = await storageService.checkDuplicate(english);
          if (existing) {
            skippedCount++;
            continue;
          }

          processedEnglish.add(normalizedEnglish);

          const id = generateUUID();
          newSentences.push({
            id,
            english,
            chinese,
            addedAt: baseTime + index,
            lastReviewedAt: null,
            nextReviewDate: null,
            intervalIndex: 0,
            masteryLevel: 0,
            timesReviewed: 0,
            wrongDictations: 0,
            tags: getSafeTags(row.Tags || row['标签'] || row.tags || row['tags']),
            updatedAt: Date.now(),
            isManual: false
          });

          setImportProgress(prev => ({
            ...prev,
            processed: index + 1,
            success: newSentences.length,
            skipped: skippedCount
          }));

          if (index % 50 === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
          }
        }

        if (newSentences.length > 0) {
          await storageService.saveSentences(newSentences);
          await onUpdate();
        }

        setImportProgress(prev => ({
          ...prev,
          processed: data.length,
          success: newSentences.length,
          skipped: skippedCount,
          errors,
          status: 'done'
        }));
      } catch (err) {
        console.error('Import Error:', err);
        setImportProgress(prev => ({
          ...prev,
          status: 'error',
          errors: [{ row: 0, message: '导入失败，请确保文件格式正确（支持 .xlsx, .xls 格式）。' }]
        }));
      } finally {
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    };
    reader.readAsBinaryString(file);
  };

  const resetImportProgress = useCallback(() => {
    setImportProgress({
      total: 0,
      processed: 0,
      success: 0,
      skipped: 0,
      errors: [],
      status: 'idle'
    });
  }, []);

  const filteredSentences = useMemo(() => {
    if (!deferredQuery || deferredQuery.trim() === '') return sentences;
    const query = deferredQuery.toLowerCase();
    return sentences.filter(s => 
      s.english.toLowerCase().includes(query) || 
      s.chinese.includes(query) ||
      getSafeTags(s.tags).some(t => t.toLowerCase().includes(query))
    );
  }, [sentences, deferredQuery]);

  const exportToExcel = useCallback(() => {
    const data = sentences.map(s => ({
      English: s.english,
      Chinese: s.chinese,
      Tags: getSafeTags(s.tags).join(';'),
      Stage: s.intervalIndex,
      AddedAt: new Date(s.addedAt).toLocaleString()
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sentences");
    XLSX.writeFile(wb, `Database_Backup_${new Date().toISOString().split('T')[0]}.xlsx`);
  }, [sentences]);

  return (
    <div className="space-y-10 animate-in fade-in slide-in-from-bottom-2 duration-700">
      
      {/* 统计分析部分（Memoized） */}
      <StatisticsSection 
        sentences={sentences} 
        onImportClick={() => fileInputRef.current?.click()}
        importStatus={importProgress.status}
      />
      
      {/* 隐藏的文件输入框 */}
      <input 
        type="file" 
        ref={fileInputRef} 
        className="hidden" 
        accept=".xlsx, .xls" 
        onChange={handleExcelImport}
      />

      {importProgress.status !== 'idle' && (
        <div className="apple-card p-10">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-xl font-black text-gray-900 tracking-tight">导入进度</h2>
            {(importProgress.status === 'done' || importProgress.status === 'error') && (
              <button 
                onClick={resetImportProgress}
                className="text-[10px] font-black text-gray-400 bg-gray-100 px-4 py-2 rounded-full uppercase tracking-widest hover:bg-gray-200 transition-colors"
              >
                关闭
              </button>
            )}
          </div>

          {importProgress.status === 'validating' && (
            <div className="text-center py-10">
              <div className="animate-spin w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full mx-auto mb-4"></div>
              <p className="text-gray-600 font-bold">正在验证数据...</p>
            </div>
          )}

          {importProgress.status === 'importing' && (
            <div className="space-y-6">
              <div className="flex justify-between text-sm font-bold text-gray-600">
                <span>处理中</span>
                <span>{importProgress.processed} / {importProgress.total}</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
                <div 
                  className="bg-blue-500 h-full rounded-full transition-all duration-300"
                  style={{ width: `${importProgress.total > 0 ? (importProgress.processed / importProgress.total) * 100 : 0}%` }}
                ></div>
              </div>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div className="bg-green-50 p-4 rounded-2xl">
                  <p className="text-green-600 font-black text-2xl">{importProgress.success}</p>
                  <p className="text-green-500 text-[9px] font-black uppercase tracking-widest">成功导入</p>
                </div>
                <div className="bg-amber-50 p-4 rounded-2xl">
                  <p className="text-amber-600 font-black text-2xl">{importProgress.skipped}</p>
                  <p className="text-amber-500 text-[9px] font-black uppercase tracking-widest">跳过重复</p>
                </div>
              </div>
            </div>
          )}

          {importProgress.status === 'done' && (
            <div className="space-y-6">
              <div className="grid grid-cols-3 gap-4 text-sm">
                <div className="bg-green-50 p-6 rounded-2xl text-center">
                  <p className="text-green-600 font-black text-3xl">{importProgress.success}</p>
                  <p className="text-green-500 text-[9px] font-black uppercase tracking-widest mt-2">成功导入</p>
                </div>
                <div className="bg-amber-50 p-6 rounded-2xl text-center">
                  <p className="text-amber-600 font-black text-3xl">{importProgress.skipped}</p>
                  <p className="text-amber-500 text-[9px] font-black uppercase tracking-widest mt-2">跳过重复</p>
                </div>
                <div className="bg-gray-50 p-6 rounded-2xl text-center">
                  <p className="text-gray-600 font-black text-3xl">{importProgress.errors.length}</p>
                  <p className="text-gray-500 text-[9px] font-black uppercase tracking-widest mt-2">验证错误</p>
                </div>
              </div>
              
              {importProgress.errors.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-2xl p-6">
                  <h3 className="text-red-800 font-black text-sm mb-4">验证错误详情</h3>
                  <div className="space-y-2 max-h-40 overflow-y-auto">
                    {importProgress.errors.slice(0, 10).map((err, idx) => (
                      <p key={idx} className="text-red-600 text-xs">
                        第 {err.row} 行：{err.message}
                      </p>
                    ))}
                    {importProgress.errors.length > 10 && (
                      <p className="text-red-500 text-xs italic">...还有 {importProgress.errors.length - 10} 条错误</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {importProgress.status === 'error' && (
            <div className="text-center py-10">
              <div className="text-red-500 text-4xl mb-4">❌</div>
              <p className="text-red-600 font-bold mb-2">导入失败</p>
              {importProgress.errors.map((err, idx) => (
                <p key={idx} className="text-red-500 text-sm">{err.message}</p>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="apple-card p-10 space-y-6">
        <h2 className="text-xl font-black text-gray-900 tracking-tight">手动入库</h2>
        <div className="space-y-4">
          <textarea 
            value={newEn} 
            onChange={(e) => { setNewEn(e.target.value); setDuplicateWarning({ show: false }); }} 
            placeholder="录入精彩英文句子..." 
            className="w-full p-6 bg-gray-50 rounded-[1.8rem] border-none focus:ring-2 focus:ring-gray-200 outline-none text-lg font-bold" 
            rows={2} 
          />
          <div className="grid grid-cols-2 gap-4">
            <input value={newZh} onChange={(e) => setNewZh(e.target.value)} placeholder="中文翻译" className="px-6 py-4 bg-gray-50 rounded-2xl border-none focus:ring-2 focus:ring-gray-200 outline-none text-sm font-medium" />
            <input value={newTags} onChange={(e) => setNewTags(e.target.value)} placeholder="标签 (用逗号分隔)" className="px-6 py-4 bg-gray-50 rounded-2xl border-none focus:ring-2 focus:ring-gray-200 outline-none text-sm font-medium" />
          </div>
          
          {duplicateWarning.show && duplicateWarning.existing && (
            <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
              <div className="flex items-start gap-3">
                <span className="text-amber-500 text-xl">⚠️</span>
                <div className="flex-1">
                  <p className="text-amber-800 font-bold text-sm">该英文句子已存在</p>
                  <p className="text-amber-600 text-xs mt-1">
                    已有翻译：{duplicateWarning.existing.chinese}
                  </p>
                </div>
                <button 
                  onClick={() => setDuplicateWarning({ show: false })}
                  className="text-amber-400 hover:text-amber-600 text-lg"
                >
                  ✕
                </button>
              </div>
            </div>
          )}
          
          <button onClick={addSentence} className="w-full bg-black text-white py-5 rounded-[2rem] font-black text-lg shadow-xl shadow-black/10 active:scale-95 transition-all">保存单条到数据库</button>
        </div>
      </div>

      <div className="space-y-6">
        <div className="flex justify-between items-end px-6">
           <h3 className="text-[11px] font-black text-gray-400 uppercase tracking-[0.3em]">Database Explorer</h3>
           <button onClick={exportToExcel} className="text-[9px] font-black text-blue-500 uppercase tracking-widest flex items-center gap-1.5 bg-blue-50 px-3 py-1 rounded-full">📤 导出 Excel 备份</button>
        </div>
        
        <div className="px-6">
            <input 
              type="text" 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="🔍 在词库中快速检索..."
              className="w-full px-6 py-4 bg-white/50 backdrop-blur-md rounded-2xl border border-black/5 outline-none text-sm font-bold focus:bg-white transition-all shadow-sm"
            />
        </div>

        {/* 使用提取后的句子列表组件 */}
        <SentenceList 
          sentences={filteredSentences} 
          onDelete={deleteSentence} 
          getSafeTags={getSafeTags}
        />
      </div>
    </div>
  );
};

export default ManagePage;
