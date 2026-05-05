import React, { useState, useMemo, useRef, useDeferredValue, useCallback, useEffect } from 'react';
import { Sentence } from '../types';
import { storageService } from '../services/storage';
import { generateUUID } from '../utils/uuid';
import { getSafeTags } from '../utils/format';
import { StatisticsSection } from '../components/manage/StatisticsSection';
import { SentenceList } from '../components/manage/SentenceList';

const BATCH_SIZE = 100;

interface ExcelValidationResult {
  valid: boolean;
  error?: string;
}

const validateExcelFile = async (file: File): Promise<ExcelValidationResult> => {
  const MAX_FILE_SIZE = 10 * 1024 * 1024;
  const MIN_XLSX_SIZE = 100;
  const VALID_EXTENSIONS = ['.xlsx', '.xls'];
  
  const fileExtension = file.name.toLowerCase().substring(file.name.lastIndexOf('.'));
  
  if (!VALID_EXTENSIONS.includes(fileExtension)) {
    return { valid: false, error: '请上传 Excel 文件（.xlsx 或 .xls 格式）' };
  }
  
  if (file.size < 8) {
    return { valid: false, error: '文件过小或损坏，无法识别格式' };
  }
  
  if (file.size > MAX_FILE_SIZE) {
    return { valid: false, error: `文件大小不能超过 10MB，当前文件大小：${(file.size / 1024 / 1024).toFixed(2)}MB` };
  }
  
  try {
    const arrayBuffer = await file.slice(0, 8).arrayBuffer();
    const header = new Uint8Array(arrayBuffer);
    
    if (!header || header.length < 4) {
      return { valid: false, error: '文件内容不完整，无法识别格式' };
    }
    
    const isXlsx = header[0] === 0x50 && header[1] === 0x4B && header[2] === 0x03 && header[3] === 0x04;
    const isXls = header.length >= 8 && 
      header[0] === 0xD0 && header[1] === 0xCF && header[2] === 0x11 && header[3] === 0xE0 && 
      header[4] === 0xA1 && header[5] === 0xB1 && header[6] === 0x1A && header[7] === 0xE1;
    
    if (!isXlsx && !isXls) {
      return { valid: false, error: '文件内容不是有效的 Excel 格式' };
    }
    
    if (isXlsx && file.size < MIN_XLSX_SIZE) {
      return { valid: false, error: '文件结构不完整，可能已损坏' };
    }
    
    if (isXlsx && file.size >= 1024) {
      const contentBuffer = await file.slice(0, 1024).arrayBuffer();
      const contentBytes = new Uint8Array(contentBuffer);
      const contentStr = new TextDecoder('utf-8', { fatal: false }).decode(contentBytes);
      
      const hasXlsxStructure = contentStr.includes('[Content_Types]') || 
                                contentStr.includes('.xml') ||
                                contentStr.includes('xl/');
      
      if (!hasXlsxStructure) {
        return { valid: false, error: '文件结构不完整，可能已损坏' };
      }
    }
    
    return { valid: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : '文件读取失败，请重试';
    return { valid: false, error: errorMsg };
  }
};

interface ImportProgress {
  total: number;
  processed: number;
  success: number;
  fileDuplicates: number;
  dbDuplicates: number;
  invalidRows: number;
  errors: Array<{ row: number; message: string }>;
  status: 'idle' | 'validating' | 'importing' | 'done' | 'error';
}

interface ManagePageProps {
  sentences: Sentence[];
  onUpdate: () => Promise<void>;
}

const ManagePage: React.FC<ManagePageProps> = ({ sentences, onUpdate }) => {
  const [newEn, setNewEn] = useState('');
  const [newZh, setNewZh] = useState('');
  const [newTags, setNewTags] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const deferredQuery = useDeferredValue(searchQuery);
  
  const [duplicateWarning, setDuplicateWarning] = useState<{ show: boolean; existing?: Sentence }>({ show: false });
  const [isAddingSentence, setIsAddingSentence] = useState(false);
  const isAddingSentenceRef = useRef(false);
  const [isImporting, setIsImporting] = useState(false);
  
  const [importProgress, setImportProgress] = useState<ImportProgress>({
    total: 0,
    processed: 0,
    success: 0,
    fileDuplicates: 0,
    dbDuplicates: 0,
    invalidRows: 0,
    errors: [],
    status: 'idle'
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const xlsxRef = useRef<typeof import('xlsx') | null>(null);
  const xlsxLoadPromiseRef = useRef<Promise<typeof import('xlsx')> | null>(null);
  const isMountedRef = useRef(true);
  const abortControllerRef = useRef<AbortController | null>(null);
  const englishInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  const loadXlsx = useCallback(async (): Promise<typeof import('xlsx')> => {
    if (xlsxRef.current) return xlsxRef.current;
    if (xlsxLoadPromiseRef.current) return xlsxLoadPromiseRef.current;

    xlsxLoadPromiseRef.current = import('xlsx').then(mod => {
      xlsxRef.current = mod;
      return mod;
    });
    return xlsxLoadPromiseRef.current;
  }, []);

  const addSentence = useCallback(async () => {
    const english = newEn.trim();
    const chinese = newZh.trim();

    if (!english || !chinese || isAddingSentenceRef.current) return;

    isAddingSentenceRef.current = true;
    setIsAddingSentence(true);

    try {
      const existing = await storageService.checkDuplicate(english);
      if (existing) {
        setDuplicateWarning({ show: true, existing });
        return;
      }

      const tagsArray = getSafeTags(newTags);
      
      const newItem: Sentence = {
        id: generateUUID(),
        english,
        chinese,
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
      
      await storageService.addSentence(newItem);
      
      await onUpdate();
      setNewEn('');
      setNewZh('');
      setNewTags('');
      setDuplicateWarning({ show: false });
      
      setTimeout(() => {
        englishInputRef.current?.focus();
      }, 100);
    } catch (error) {
      console.error("保存失败:", error);
    } finally {
      isAddingSentenceRef.current = false;
      setIsAddingSentence(false);
    }
  }, [newEn, newZh, newTags, onUpdate]);

  const deleteSentence = useCallback(async (id: string) => {
    if (!window.confirm('确定要从数据库中永久移除这句话吗？')) return;
    await storageService.deleteSentence(id);
    await onUpdate();
  }, [onUpdate]);

  const handleExcelImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    
    if (fileInputRef.current) fileInputRef.current.value = '';
    
    if (!file) return;

    if (isImporting) {
      setImportProgress({
        total: 0,
        processed: 0,
        success: 0,
        fileDuplicates: 0,
        dbDuplicates: 0,
        invalidRows: 0,
        errors: [{ row: 0, message: '已有导入任务进行中，请等待完成' }],
        status: 'error'
      });
      return;
    }

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    const validation = await validateExcelFile(file);
    if (!validation.valid) {
      if (!isMountedRef.current) return;
      setImportProgress({
        total: 0,
        processed: 0,
        success: 0,
        fileDuplicates: 0,
        dbDuplicates: 0,
        invalidRows: 0,
        errors: [{ row: 0, message: validation.error || '文件验证失败' }],
        status: 'error'
      });
      return;
    }

    const MAX_IMPORT_COUNT = 5000;
    const MAX_ENGLISH_LENGTH = 1000;
    const MAX_CHINESE_LENGTH = 500;

    if (!isMountedRef.current) return;
    setIsImporting(true);
    setImportProgress({
      total: 0,
      processed: 0,
      success: 0,
      fileDuplicates: 0,
      dbDuplicates: 0,
      invalidRows: 0,
      errors: [],
      status: 'validating'
    });

    const reader = new FileReader();
    
    reader.onerror = () => {
      if (!isMountedRef.current) return;
      setIsImporting(false);
      setImportProgress(prev => ({
        ...prev,
        status: 'error',
        errors: [{ row: 0, message: '文件读取失败，请重试。' }]
      }));
    };

    reader.onload = async (evt) => {
      if (signal.aborted || !isMountedRef.current) {
        setIsImporting(false);
        return;
      }
      
      try {
        const XLSX = await loadXlsx();
        const arrayBuffer = evt.target?.result;
        const wb = XLSX.read(arrayBuffer, { type: 'array' });
        
        if (!wb.SheetNames || wb.SheetNames.length === 0) {
          if (!isMountedRef.current) return;
          setIsImporting(false);
          setImportProgress(prev => ({
            ...prev,
            status: 'error',
            errors: [{ row: 0, message: '文件不是有效的 Excel 工作簿（无工作表）' }]
          }));
          return;
        }
        
        const wsname = wb.SheetNames[0];
        const ws = wb.Sheets[wsname];
        const data = XLSX.utils.sheet_to_json(ws) as Record<string, unknown>[];

        if (data.length === 0) {
          if (!isMountedRef.current) return;
          setIsImporting(false);
          setImportProgress(prev => ({
            ...prev,
            status: 'error',
            errors: [{ row: 0, message: 'Excel 文件为空，请检查文件内容。' }]
          }));
          return;
        }

        if (data.length > MAX_IMPORT_COUNT) {
          if (!isMountedRef.current) return;
          setIsImporting(false);
          setImportProgress(prev => ({
            ...prev,
            status: 'error',
            errors: [{ row: 0, message: `单次导入数量不能超过 ${MAX_IMPORT_COUNT} 条，当前有 ${data.length} 条数据。` }]
          }));
          return;
        }

        const existingEnglishSet = new Set<string>();
        sentences.forEach(s => {
          existingEnglishSet.add(s.english.toLowerCase());
        });

        if (!isMountedRef.current) return;
        setImportProgress(prev => ({ ...prev, total: data.length, status: 'importing' }));

        const baseTime = Date.now();
        const importTimestamp = baseTime;
        const newSentences: Array<{ sentence: Sentence; rowIndex: number }> = [];
        const errors: Array<{ row: number; message: string }> = [];
        let fileDuplicatesCount = 0;
        let dbDuplicatesCount = 0;
        let invalidRowsCount = 0;
        
        const processedEnglish = new Set<string>();

        const findColumnValue = (row: Record<string, unknown>, patterns: string[]): string => {
          for (const pattern of patterns) {
            if (row[pattern] !== undefined && row[pattern] !== null) {
              return String(row[pattern]).trim();
            }
            const key = Object.keys(row).find(k => k.toLowerCase() === pattern.toLowerCase());
            if (key && row[key] !== undefined && row[key] !== null) {
              return String(row[key]).trim();
            }
          }
          return '';
        };

        const englishPatterns = [
          'English', 'english', '英文', '单词', '词汇', '词',
          'Front', 'front', '正面', 'Word', 'word', 'Term', 'term',
          'Source', 'source', '原词', 'Original', 'original',
          'A', 'a', '列A', '列1', 'Column A', 'column_a'
        ];

        const chinesePatterns = [
          'Chinese', 'chinese', '中文', '翻译', '释义', '意思',
          'Back', 'back', '背面', 'Meaning', 'meaning', 'Definition', 'definition',
          'Translation', 'translation', '译文', '解释',
          'B', 'b', '列B', '列2', 'Column B', 'column_b'
        ];

        for (let index = 0; index < data.length; index++) {
          if (signal.aborted || !isMountedRef.current) {
            setIsImporting(false);
            return;
          }
          
          const row = data[index];
          const english = findColumnValue(row, englishPatterns);
          const chinese = findColumnValue(row, chinesePatterns);
          
          if (!english || !chinese) {
            errors.push({ row: index + 1, message: '英文或中文为空' });
            invalidRowsCount++;
            if (index % 50 === 0 || index === data.length - 1) {
              if (!isMountedRef.current) return;
              setImportProgress(prev => ({ ...prev, processed: index + 1, errors, invalidRows: invalidRowsCount }));
              await new Promise(resolve => setTimeout(resolve, 0));
            }
            continue;
          }

          if (english.length > MAX_ENGLISH_LENGTH) {
            errors.push({ row: index + 1, message: `英文内容过长（${english.length}字符）` });
            invalidRowsCount++;
            if (index % 50 === 0 || index === data.length - 1) {
              if (!isMountedRef.current) return;
              setImportProgress(prev => ({ ...prev, processed: index + 1, errors, invalidRows: invalidRowsCount }));
              await new Promise(resolve => setTimeout(resolve, 0));
            }
            continue;
          }

          if (chinese.length > MAX_CHINESE_LENGTH) {
            errors.push({ row: index + 1, message: `中文内容过长（${chinese.length}字符）` });
            invalidRowsCount++;
            if (index % 50 === 0 || index === data.length - 1) {
              if (!isMountedRef.current) return;
              setImportProgress(prev => ({ ...prev, processed: index + 1, errors, invalidRows: invalidRowsCount }));
              await new Promise(resolve => setTimeout(resolve, 0));
            }
            continue;
          }

          const normalizedEnglish = english.toLowerCase();
          
          if (processedEnglish.has(normalizedEnglish)) {
            fileDuplicatesCount++;
            if (index % 50 === 0 || index === data.length - 1) {
              if (!isMountedRef.current) return;
              setImportProgress(prev => ({ ...prev, processed: index + 1, fileDuplicates: fileDuplicatesCount }));
              await new Promise(resolve => setTimeout(resolve, 0));
            }
            continue;
          }

          processedEnglish.add(normalizedEnglish);

          if (existingEnglishSet.has(normalizedEnglish)) {
            dbDuplicatesCount++;
            if (index % 50 === 0 || index === data.length - 1) {
              if (!isMountedRef.current) return;
              setImportProgress(prev => ({ ...prev, processed: index + 1, dbDuplicates: dbDuplicatesCount }));
              await new Promise(resolve => setTimeout(resolve, 0));
            }
            continue;
          }

          const id = generateUUID();
          newSentences.push({
            sentence: {
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
              updatedAt: importTimestamp,
              isManual: false
            },
            rowIndex: index + 1
          });

          if (index % 50 === 0 || index === data.length - 1) {
            if (!isMountedRef.current) return;
            setImportProgress(prev => ({
              ...prev,
              processed: index + 1,
              success: newSentences.length,
              fileDuplicates: fileDuplicatesCount,
              dbDuplicates: dbDuplicatesCount,
              invalidRows: invalidRowsCount
            }));
            await new Promise(resolve => setTimeout(resolve, 0));
          }
        }

        if (newSentences.length > 0) {
          let totalSaved = 0;
          const batchErrors: Array<{ row: number; message: string }> = [];
          
          for (let i = 0; i < newSentences.length; i += BATCH_SIZE) {
            if (signal.aborted || !isMountedRef.current) {
              setIsImporting(false);
              setImportProgress(prev => ({
                ...prev,
                status: 'error',
                errors: [{ row: 0, message: '导入已取消' }]
              }));
              return;
            }
            
            const batch = newSentences.slice(i, i + BATCH_SIZE);
            const batchSentences = batch.map(item => item.sentence);
            
            try {
              const result = await storageService.saveSentences(batchSentences);
              totalSaved += result.saved;
              
              if (result.duplicates > 0) {
                batchErrors.push({ 
                  row: batch[0].rowIndex, 
                  message: `批次 ${Math.floor(i / BATCH_SIZE) + 1} 有 ${result.duplicates} 条重复被跳过` 
                });
              }
              
              if (!isMountedRef.current) {
                setIsImporting(false);
                return;
              }
              setImportProgress(prev => ({
                ...prev,
                success: totalSaved,
                errors: [...prev.errors, ...batchErrors]
              }));
            } catch (batchErr: unknown) {
              const errorMsg = batchErr instanceof Error ? batchErr.message : '未知错误';
              batchErrors.push({ 
                row: batch[0].rowIndex, 
                message: `批次 ${Math.floor(i / BATCH_SIZE) + 1} 保存失败: ${errorMsg}` 
              });
              console.error(`批次 ${Math.floor(i / BATCH_SIZE) + 1} 保存失败:`, batchErr);
            }
          }
          
          await onUpdate();
          
          if (!isMountedRef.current) {
            setIsImporting(false);
            return;
          }
          setImportProgress(prev => ({
            ...prev,
            processed: data.length,
            success: totalSaved,
            fileDuplicates: fileDuplicatesCount,
            dbDuplicates: dbDuplicatesCount,
            invalidRows: invalidRowsCount,
            errors: [...errors, ...batchErrors],
            status: 'done'
          }));
        } else {
          if (!isMountedRef.current) {
            setIsImporting(false);
            return;
          }
          setImportProgress(prev => ({
            ...prev,
            processed: data.length,
            success: 0,
            fileDuplicates: fileDuplicatesCount,
            dbDuplicates: dbDuplicatesCount,
            invalidRows: invalidRowsCount,
            errors,
            status: 'done'
          }));
        }
      } catch (err: unknown) {
        console.error('Import Error:', err);
        if (!isMountedRef.current) {
          setIsImporting(false);
          return;
        }
        const errorMessage = err instanceof Error 
          ? err.message 
          : '导入失败，请确保文件格式正确（支持 .xlsx, .xls 格式）。';
        setImportProgress(prev => ({
          ...prev,
          status: 'error',
          errors: [{ row: 0, message: errorMessage }]
        }));
      } finally {
        setIsImporting(false);
      }
    };
    reader.readAsArrayBuffer(file);
  }, [sentences, onUpdate, isImporting]);

  const resetImportProgress = useCallback(() => {
    setImportProgress({
      total: 0,
      processed: 0,
      success: 0,
      fileDuplicates: 0,
      dbDuplicates: 0,
      invalidRows: 0,
      errors: [],
      status: 'idle'
    });
  }, []);

  const sentenceTagsMap = useMemo(() => {
    return new Map(sentences.map(s => [s.id, getSafeTags(s.tags)]));
  }, [sentences]);

  const filteredSentences = useMemo(() => {
    if (!deferredQuery || deferredQuery.trim() === '') return sentences;
    const query = deferredQuery.toLowerCase();
    return sentences.filter(s => {
      const tags = sentenceTagsMap.get(s.id) || [];
      return s.english.toLowerCase().includes(query) || 
        s.chinese.includes(query) ||
        tags.some(t => t.toLowerCase().includes(query));
    });
  }, [sentences, deferredQuery, sentenceTagsMap]);

  const exportToExcel = useCallback(async () => {
    const XLSX = await loadXlsx();
    const data = sentences.map(s => {
      const tags = sentenceTagsMap.get(s.id) || [];
      return {
        English: s.english,
        Chinese: s.chinese,
        Tags: tags.join(';'),
        Stage: s.intervalIndex,
        AddedAt: new Date(s.addedAt).toLocaleString()
      };
    });
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sentences");
    XLSX.writeFile(wb, `Database_Backup_${new Date().toISOString().split('T')[0]}.xlsx`);
  }, [sentences, sentenceTagsMap]);

  return (
    <div className="space-y-10 animate-in fade-in slide-in-from-bottom-2 duration-700">
      
      {/* 统计分析部分（Memoized） */}
      <StatisticsSection 
        sentences={sentences} 
        onImportClick={() => {
          if (!isImporting) {
            fileInputRef.current?.click();
          }
        }}
        importStatus={importProgress.status}
      />
      
      {/* 隐藏的文件输入框 */}
      <input 
        type="file" 
        ref={fileInputRef} 
        className="absolute opacity-0 pointer-events-none w-0 h-0" 
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
                className="text-[10px] font-black text-gray-600 bg-gray-100 px-4 py-2 rounded-full uppercase tracking-widest hover:bg-gray-200 transition-colors"
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
              <div className="grid grid-cols-4 gap-4 text-sm">
                <div className="bg-green-50 p-4 rounded-2xl">
                  <p className="text-green-600 font-black text-2xl">{importProgress.success}</p>
                  <p className="text-green-500 text-[9px] font-black uppercase tracking-widest">成功导入</p>
                </div>
                <div className="bg-amber-50 p-4 rounded-2xl">
                  <p className="text-amber-600 font-black text-2xl">{importProgress.fileDuplicates}</p>
                  <p className="text-amber-500 text-[9px] font-black uppercase tracking-widest">文件内重复</p>
                </div>
                <div className="bg-orange-50 p-4 rounded-2xl">
                  <p className="text-orange-600 font-black text-2xl">{importProgress.dbDuplicates}</p>
                  <p className="text-orange-500 text-[9px] font-black uppercase tracking-widest">数据库已存在</p>
                </div>
                <div className="bg-gray-50 p-4 rounded-2xl">
                  <p className="text-gray-600 font-black text-2xl">{importProgress.invalidRows}</p>
                  <p className="text-gray-500 text-[9px] font-black uppercase tracking-widest">无效行</p>
                </div>
              </div>
              <button
                onClick={() => {
                  if (abortControllerRef.current) {
                    abortControllerRef.current.abort();
                    setIsImporting(false);
                    setImportProgress(prev => ({ ...prev, status: 'error', errors: [{ row: 0, message: '导入已取消' }] }));
                  }
                }}
                className="w-full py-3 px-4 bg-red-500 hover:bg-red-600 text-white font-bold rounded-xl transition-colors"
              >
                取消导入
              </button>
            </div>
          )}

          {importProgress.status === 'done' && (
            <div className="space-y-6">
              <div className="grid grid-cols-4 gap-4 text-sm">
                <div className="bg-green-50 p-6 rounded-2xl text-center">
                  <p className="text-green-600 font-black text-3xl">{importProgress.success}</p>
                  <p className="text-green-500 text-[9px] font-black uppercase tracking-widest mt-2">成功导入</p>
                </div>
                <div className="bg-amber-50 p-6 rounded-2xl text-center">
                  <p className="text-amber-600 font-black text-3xl">{importProgress.fileDuplicates}</p>
                  <p className="text-amber-500 text-[9px] font-black uppercase tracking-widest mt-2">文件内重复</p>
                </div>
                <div className="bg-orange-50 p-6 rounded-2xl text-center">
                  <p className="text-orange-600 font-black text-3xl">{importProgress.dbDuplicates}</p>
                  <p className="text-orange-500 text-[9px] font-black uppercase tracking-widest mt-2">数据库已存在</p>
                </div>
                <div className="bg-gray-50 p-6 rounded-2xl text-center">
                  <p className="text-gray-600 font-black text-3xl">{importProgress.invalidRows}</p>
                  <p className="text-gray-600 text-[9px] font-black uppercase tracking-widest mt-2">无效行</p>
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
            ref={englishInputRef}
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
          
          <button 
            onClick={addSentence} 
            disabled={isAddingSentence}
            className={`w-full py-5 rounded-[2rem] font-black text-lg shadow-xl transition-all ${
              isAddingSentence 
                ? 'bg-gray-400 cursor-not-allowed' 
                : 'bg-black text-white active:scale-95 shadow-black/10'
            }`}
          >
            {isAddingSentence ? (
              <span className="flex items-center justify-center gap-2">
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                正在保存...
              </span>
            ) : (
              "保存单条到数据库"
            )}
          </button>
        </div>
      </div>

      <div className="space-y-6">
        <div className="flex justify-between items-end px-6">
           <h3 className="text-[11px] font-black text-gray-600 uppercase tracking-[0.3em]">Database Explorer</h3>
           <button onClick={exportToExcel} className="text-[10px] font-black text-blue-500 uppercase tracking-widest flex items-center gap-1.5 bg-blue-50 px-4 py-2 rounded-full hover:bg-blue-100 transition-all">📤 导出 Excel 备份</button>
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
        />
      </div>
    </div>
  );
};

export default ManagePage;
