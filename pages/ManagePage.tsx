import React, { useState, useMemo, useRef } from 'react';
import { Sentence } from '../types';
import { storageService } from '../services/storageService';
import { PieChart, Pie, Cell, Tooltip, BarChart, Bar, XAxis, YAxis } from 'recharts';
import * as XLSX from 'xlsx';

interface ManagePageProps {
  sentences: Sentence[];
  onUpdate: () => Promise<void>;
}

const ManagePage: React.FC<ManagePageProps> = ({ sentences, onUpdate }) => {
  const [newEn, setNewEn] = useState('');
  const [newZh, setNewZh] = useState('');
  const [newTags, setNewTags] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 轻量标签缓存
  let tagCache: Record<string, string[]> = {};
  const getSafeTags = (tags: unknown): string[] => {
    const cacheKey = typeof tags === 'string' ? tags : JSON.stringify(tags);
    if (tagCache[cacheKey]) return tagCache[cacheKey];
    
    let result: string[] = [];
    if (Array.isArray(tags)) {
      result = tags.filter(tag => typeof tag === 'string' && tag.trim() !== '');
    } else if (typeof tags === 'string') {
      result = tags.split(/[，,;；]/).map(t => t.trim()).filter(t => t !== '');
    }
    tagCache[cacheKey] = result;
    return result;
  };

  const addSentence = async () => {
    if (!newEn || !newZh) return;
    const tagsArray = getSafeTags(newTags);
    
    const newItem: Sentence = {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
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
    await storageService.addSentence(newItem);
    await onUpdate();
    setNewEn('');
    setNewZh('');
    setNewTags('');
  };

  const deleteSentence = async (id: string) => {
    if (!window.confirm('确定要从数据库中永久移除这句话吗？')) return;
    await storageService.deleteSentence(id);
    await onUpdate();
  };

  const handleExcelImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsImporting(true);
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const bstr = evt.target?.result;
        const wb = XLSX.read(bstr, { type: 'binary' });
        const wsname = wb.SheetNames[0];
        const ws = wb.Sheets[wsname];
        const data = XLSX.utils.sheet_to_json(ws) as any[];

        const baseTime = Date.now();
        const newSentences: Sentence[] = data
          .filter(row => (row.English || row['英文']) && (row.Chinese || row['中文']))
          .map((row, index) => ({
            id: Date.now().toString() + index + Math.random().toString(36).substr(2, 5),
            english: String(row.English || row['英文']).trim(),
            chinese: String(row.Chinese || row['中文']).trim(),
            addedAt: baseTime + index, 
            lastReviewedAt: null,
            nextReviewDate: null,
            intervalIndex: 0,
            masteryLevel: 0,
            timesReviewed: 0,
            wrongDictations: 0,
            tags: getSafeTags(row.Tags || row['标签']),
            updatedAt: Date.now(),
            isManual: false 
          }));

        if (newSentences.length > 0) {
          await storageService.saveSentences(newSentences);
          await onUpdate();
          alert(`成功导入 ${newSentences.length} 条句子！`);
        } else {
          alert('未能识别有效数据，请检查 Excel 列名（需包含 English 和 Chinese）。');
        }
      } catch (err) {
        console.error('Import Error:', err);
        alert('导入失败，请确保文件格式正确。');
      } finally {
        setIsImporting(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    };
    reader.readAsBinaryString(file);
  };

  const filteredSentences = useMemo(() => {
    if (!searchQuery || searchQuery.trim() === '') return sentences;
    const query = searchQuery.toLowerCase();
    return sentences.filter(s => 
      s.english.toLowerCase().includes(query) || 
      s.chinese.includes(query) ||
      getSafeTags(s.tags).some(t => t.toLowerCase().includes(query))
    );
  }, [sentences, searchQuery]);

  const stats = useMemo(() => {
    if (sentences.length === 0) {
      return {
        mastery: [{ name: '初识', value: 0, color: '#e5e7eb' }, { name: '复习中', value: 0, color: '#3b82f6' }, { name: '完全掌握', value: 0, color: '#10b981' }],
        tagData: []
      };
    }

    const mastery = [
      { name: '初识', value: sentences.filter(s => s.intervalIndex === 0).length, color: '#e5e7eb' },
      { name: '复习中', value: sentences.filter(s => s.intervalIndex > 0 && s.intervalIndex < 9).length, color: '#3b82f6' },
      { name: '完全掌握', value: sentences.filter(s => s.intervalIndex >= 9).length, color: '#10b981' }
    ];
    
    const tagMap: Record<string, number> = {};
    sentences.forEach(s => {
      const safeTags = getSafeTags(s.tags);
      safeTags.forEach(tag => {
        tagMap[tag] = (tagMap[tag] || 0) + 1;
      });
    });
    
    const tagData = Object.entries(tagMap)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);
    
    return { mastery, tagData };
  }, [sentences]);

  const exportToExcel = () => {
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
  };

  return (
    <div className="space-y-10 animate-in fade-in slide-in-from-bottom-2 duration-700">
      <div className="grid grid-cols-2 gap-4">
        <div className="apple-card p-8 flex flex-col justify-center items-center text-center">
          <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-2">DB 存储版本</p>
          <h4 className="text-3xl font-black text-blue-600">v1.1</h4>
        </div>
        <div className="apple-card p-8 flex flex-col justify-center items-center text-center">
          <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-2">数据库条目</p>
          <h4 className="text-3xl font-black text-gray-800">{sentences.length}</h4>
        </div>
      </div>

      <div className="apple-card p-10 space-y-10">
        <div className="flex justify-between items-center">
          <h2 className="text-xl font-black text-gray-900 tracking-tight">知识库全景分析</h2>
          <div className="flex gap-2">
            <button 
              onClick={() => fileInputRef.current?.click()}
              disabled={isImporting}
              className="text-[10px] font-black text-green-600 bg-green-50 px-4 py-2 rounded-full uppercase tracking-widest hover:bg-green-100 transition-colors"
            >
              {isImporting ? '导入中...' : '📥 导入 Excel'}
            </button>
            <input 
              type="file" 
              ref={fileInputRef} 
              className="hidden" 
              accept=".xlsx, .xls" 
              onChange={handleExcelImport}
            />
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
          <div className="space-y-6 text-center md:text-left">
            <h3 className="text-[11px] font-black text-gray-300 uppercase tracking-widest">MASTERY DISTRIBUTION</h3>
            <div className="h-48 min-h-48 relative">
              {/* 移除 ResponsiveContainer，直接用固定宽高渲染饼图 */}
              <PieChart width={200} height={200}>
                <Pie data={stats.mastery} dataKey="value" innerRadius={50} outerRadius={70} paddingAngle={10} stroke="none">
                  {stats.mastery.map((entry, index) => <Cell key={index} fill={entry.color} />)}
                </Pie>
                <Tooltip contentStyle={{borderRadius: '1.2rem', border: 'none', boxShadow: '0 8px 24px rgba(0,0,0,0.05)'}} />
              </PieChart>
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <span className="text-2xl font-black text-gray-800">{sentences.length}</span>
                <span className="text-[8px] font-bold text-gray-400 uppercase tracking-widest">RECORDS</span>
              </div>
            </div>
          </div>
          <div className="space-y-6">
            <h3 className="text-[11px] font-black text-gray-300 uppercase tracking-widest">HOT KEYWORDS</h3>
            <div className="h-48 min-h-48">
              {/* 移除 ResponsiveContainer，直接用固定宽高渲染柱状图 */}
              {stats.tagData.length > 0 ? (
                <BarChart width={300} height={150} data={stats.tagData} layout="vertical" margin={{left: 0, right: 30}}>
                  <XAxis type="number" hide />
                  <YAxis dataKey="name" type="category" axisLine={false} tickLine={false} tick={{fontSize: 11, fontWeight: 700, fill: '#1f2937'}} width={60} />
                  <Bar dataKey="value" fill="#3b82f6" radius={[0, 8, 8, 0]} barSize={12} />
                </BarChart>
              ) : (
                <div className="h-full flex items-center justify-center text-gray-300 text-xs italic">库内暂无标签</div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="apple-card p-10 space-y-6">
        <h2 className="text-xl font-black text-gray-900 tracking-tight">手动入库</h2>
        <div className="space-y-4">
          <textarea 
            value={newEn} 
            onChange={(e) => setNewEn(e.target.value)} 
            placeholder="录入精彩英文句子..." 
            className="w-full p-6 bg-gray-50 rounded-[1.8rem] border-none focus:ring-2 focus:ring-gray-200 outline-none text-lg font-bold" 
            rows={2} 
          />
          <div className="grid grid-cols-2 gap-4">
            <input value={newZh} onChange={(e) => setNewZh(e.target.value)} placeholder="中文翻译" className="px-6 py-4 bg-gray-50 rounded-2xl border-none focus:ring-2 focus:ring-gray-200 outline-none text-sm font-medium" />
            <input value={newTags} onChange={(e) => setNewTags(e.target.value)} placeholder="标签 (用逗号分隔)" className="px-6 py-4 bg-gray-50 rounded-2xl border-none focus:ring-2 focus:ring-gray-200 outline-none text-sm font-medium" />
          </div>
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

        <div className="space-y-4 pb-20">
          {filteredSentences.map(s => (
            <div key={s.id} className="apple-card p-8 group relative hover:border-blue-100/50 transition-all">
              <div className="flex justify-between items-start mb-4">
                <div className="flex-1 pr-10">
                  <p className="text-lg font-black text-gray-900 leading-tight mb-2">{s.english}</p>
                  <p className="text-sm text-gray-500 font-medium italic">{s.chinese}</p>
                </div>
                <button onClick={() => deleteSentence(s.id)} className="w-8 h-8 flex items-center justify-center text-gray-300 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all">✕</button>
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
                <span className="text-[9px] font-black text-gray-300 uppercase tracking-[0.2em]">{s.intervalIndex >= 9 ? 'MASTERED' : `STAGE ${s.intervalIndex}`}</span>
              </div>
            </div>
          ))}
          {filteredSentences.length === 0 && (
              <div className="p-20 text-center opacity-30 text-xs font-black uppercase tracking-widest">No entries found</div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ManagePage;