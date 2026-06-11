import React, { useState, useMemo, useCallback } from 'react';
import {
  ScheduleEvent,
  CalendarDay,
  CalendarWeek,
  loadEvents,
  saveEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  getCalendarWeeks,
  getWeekDays,
  getEventsForDate,
  formatEventTime,
  formatEventDate,
  EVENT_COLORS,
  REMINDER_OPTIONS,
  RepeatConfig,
} from '../../core/schedule/scheduleService';
import { METRICS } from '../../core/analytics/dataStats';
import { Sentence } from '../../types';
import { getLocalDateString } from '../../utils/date';

type ViewMode = 'day' | 'week' | 'month';

const WEEKDAY_NAMES = ['一', '二', '三', '四', '五', '六', '日'];
const MONTH_NAMES = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

interface CalendarProps {
  sentences?: Sentence[];
}

export const Calendar: React.FC<CalendarProps> = ({ sentences = [] }) => {
  const [events, setEvents] = useState<ScheduleEvent[]>(() => loadEvents());
  const [viewMode, setViewMode] = useState<ViewMode>('month');
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [showEventModal, setShowEventModal] = useState(false);
  const [editingEvent, setEditingEvent] = useState<ScheduleEvent | null>(null);

  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  const calendarWeeks = useMemo(() => {
    return getCalendarWeeks(events, currentDate.getFullYear(), currentDate.getMonth());
  }, [events, currentDate]);

  const weekDays = useMemo(() => {
    return getWeekDays(events, selectedDate || currentDate);
  }, [events, selectedDate, currentDate]);

  const dayEvents = useMemo(() => {
    return getEventsForDate(events, selectedDate || today);
  }, [events, selectedDate, today]);

  const scheduledSentenceMap = useMemo(() => {
    const map = new Map<string, Sentence[]>();
    const totalSentences = sentences.length;
    let scheduledCount = 0;
    for (const s of sentences) {
      if (s.scheduledDate && s.intervalIndex === 0) {
        const existing = map.get(s.scheduledDate) || [];
        existing.push(s);
        map.set(s.scheduledDate, existing);
        scheduledCount++;
      }
    }
    console.log(`📅 [Calendar] 预定数据加载完成:`);
    console.log(`  - 总句子数: ${totalSentences}`);
    console.log(`  - 有预定日期的句子: ${scheduledCount}`);
    console.log(`  - 涉及日期数: ${map.size}`);
    if (map.size > 0) {
      const sortedDates = Array.from(map.keys()).sort();
      console.log(`  - 日期列表: [${sortedDates.join(', ')}]`);
      sortedDates.forEach(date => {
        const sents = map.get(date)!;
        console.log(`    ${date}: ${sents.length}句 → [${sents.map(s => s.english.slice(0, 30)).join(' | ')}]`);
      });
    } else {
      console.log(`  - ⚠️ 没有找到任何带 scheduledDate 的句子`);
    }
    return map;
  }, [sentences]);

  const navigateMonth = (direction: number) => {
    const newDate = new Date(currentDate);
    newDate.setMonth(newDate.getMonth() + direction);
    console.log(`📅 [Calendar] 月份导航: ${currentDate.getFullYear()}/${currentDate.getMonth() + 1} → ${newDate.getFullYear()}/${newDate.getMonth() + 1} (${direction > 0 ? '前进' : '后退'})`);
    setCurrentDate(newDate);
  };

  const navigateWeek = (direction: number) => {
    const newDate = new Date(selectedDate || currentDate);
    newDate.setDate(newDate.getDate() + direction * 7);
    console.log(`📅 [Calendar] 周导航: ${getLocalDateString(selectedDate || currentDate)} → ${getLocalDateString(newDate)} (${direction > 0 ? '前进' : '后退'}${Math.abs(direction)}周)`);
    setCurrentDate(newDate);
    setSelectedDate(newDate);
  };

  const handleDateClick = (day: CalendarDay) => {
    const dateStr = getLocalDateString(day.date);
    const daySentences = scheduledSentenceMap.get(dateStr);
    console.log(`📅 [Calendar] 日期点击: ${dateStr} | 当月:${day.isCurrentMonth} | 今天:${day.isToday} | 预定句子:${daySentences?.length || 0}句 | 日程:${day.events.length}个`);
    setSelectedDate(day.date);
    if (viewMode === 'month') {
      console.log(`📅 [Calendar] 视图切换: month → day (点击了日期)`);
      setViewMode('day');
    }
  };

  const handleAddEvent = () => {
    setEditingEvent(null);
    setShowEventModal(true);
  };

  const handleEditEvent = (event: ScheduleEvent) => {
    setEditingEvent(event);
    setShowEventModal(true);
  };

  const handleDeleteEvent = (eventId: string) => {
    const updated = deleteEvent(events, eventId);
    setEvents(updated);
    saveEvents(updated);
  };

  const handleSaveEvent = (eventData: Partial<ScheduleEvent>) => {
    let updated: ScheduleEvent[];
    
    if (editingEvent) {
      updated = updateEvent(events, editingEvent.id, eventData);
    } else {
      const newEvent = createEvent({
        ...eventData,
        start: eventData.start || (selectedDate?.getTime() || Date.now()),
        end: eventData.end || (selectedDate?.getTime() || Date.now()) + 3600000,
      });
      updated = [...events, newEvent];
    }
    
    setEvents(updated);
    saveEvents(updated);
    setShowEventModal(false);
    setEditingEvent(null);
  };

  return (
    <div className="bg-white/60 backdrop-blur-xl rounded-[28px] p-6 border border-white/40">
      <div className="flex items-center justify-between mb-5">
        <h3 className="text-sm font-black text-gray-900 flex items-center gap-2">
          <span className="w-1.5 h-4 bg-indigo-500 rounded-full"></span>
          日程表
        </h3>
        
        <div className="flex items-center gap-2">
          <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
            {(['day', 'week', 'month'] as ViewMode[]).map(mode => (
              <button
                key={mode}
                onClick={() => {
                  console.log(`📅 [Calendar] 视图切换: ${viewMode} → ${mode}`);
                  setViewMode(mode);
                }}
                className={`px-3 py-1.5 text-[10px] font-bold rounded-lg transition-all ${
                  viewMode === mode 
                    ? 'bg-white text-indigo-600 shadow-sm' 
                    : 'text-gray-600 hover:text-gray-800'
                }`}
              >
                {mode === 'day' ? '日' : mode === 'week' ? '周' : '月'}
              </button>
            ))}
          </div>
          
          <button
            onClick={handleAddEvent}
            className="px-3 py-1.5 bg-indigo-500 text-white text-[10px] font-bold rounded-lg hover:bg-indigo-600 transition-colors"
          >
            + 添加
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between mb-4">
        <button
          onClick={() => viewMode === 'month' ? navigateMonth(-1) : navigateWeek(-1)}
          className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
        >
          ‹
        </button>
        
        <div className="text-sm font-bold text-gray-900">
          {viewMode === 'month' 
            ? `${currentDate.getFullYear()}年 ${MONTH_NAMES[currentDate.getMonth()]}`
            : viewMode === 'week'
              ? `${currentDate.getFullYear()}年 第${Math.ceil(currentDate.getDate() / 7)}周`
              : formatEventDate(selectedDate?.getTime() || Date.now())
          }
        </div>
        
        <button
          onClick={() => viewMode === 'month' ? navigateMonth(1) : navigateWeek(1)}
          className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
        >
          ›
        </button>
      </div>

      {viewMode === 'month' && (
        <div className="grid grid-cols-7 gap-1">
          {WEEKDAY_NAMES.map(name => (
            <div key={name} className="text-center text-[10px] font-bold text-gray-600 py-2">
              {name}
            </div>
          ))}
          
          {((): React.ReactNode => {
            const matchedDates: string[] = [];
            const nodes = calendarWeeks.map((week, wi) => 
              week.days.map((day, di) => {
                const dateStr = getLocalDateString(day.date);
                const daySentences = scheduledSentenceMap.get(dateStr);
                const sentenceCount = daySentences ? daySentences.length : 0;
                if (sentenceCount > 0) matchedDates.push(`${dateStr}(${sentenceCount}句)`);
                return (
                <div
                  key={`${wi}-${di}`}
                  onClick={() => handleDateClick(day)}
                className={`
                  min-h-[60px] p-1 rounded-lg cursor-pointer transition-all
                  ${day.isCurrentMonth ? 'bg-gray-50' : 'bg-gray-50/50'}
                  ${day.isToday ? 'ring-2 ring-indigo-500' : ''}
                  hover:bg-indigo-50
                `}
              >
                <div className={`text-xs font-bold mb-1 ${
                  day.isToday ? 'text-indigo-600' : 
                  day.isCurrentMonth ? 'text-gray-900' : 'text-gray-600'
                }`}>
                  {day.date.getDate()}
                </div>
                {sentenceCount > 0 && (
                  <div className="text-[8px] truncate px-1 py-0.5 rounded mb-0.5 bg-emerald-100 text-emerald-700 font-bold">
                    📖 {sentenceCount}句
                  </div>
                )}
                {day.events.slice(0, sentenceCount > 0 ? 1 : 2).map(event => (
                  <div
                    key={event.id}
                    className="text-[8px] truncate px-1 py-0.5 rounded mb-0.5"
                    style={{ backgroundColor: event.color + '20', color: event.color }}
                  >
                    {event.title}
                  </div>
                ))}
                {day.events.length + sentenceCount > 2 && (
                  <div className="text-[8px] text-gray-600 text-center">
                    +{day.events.length + sentenceCount - 2}
                  </div>
                )}
              </div>
            );
          })
        );
          console.log(`📅 [Calendar] 月视图渲染: ${currentDate.getFullYear()}/${currentDate.getMonth() + 1} | 匹配日期: ${matchedDates.length > 0 ? matchedDates.join(', ') : '(无)'}`);
          return nodes;
        })()}
      </div>
      )}

      {viewMode === 'week' && (
        <div className="grid grid-cols-7 gap-2">
          {((): React.ReactNode => {
            const weekMatchedDates: string[] = [];
            const weekNodes = weekDays.map((day, i) => {
            const dateStr = getLocalDateString(day.date);
            const daySentences = scheduledSentenceMap.get(dateStr);
            const sentenceCount = daySentences ? daySentences.length : 0;
            if (sentenceCount > 0) weekMatchedDates.push(`${dateStr}(${sentenceCount}句)`);
            return (
            <div key={i} className="text-center">
              <div className="text-[10px] font-bold text-gray-600 mb-1">
                {WEEKDAY_NAMES[i]}
              </div>
              <div
                onClick={() => setSelectedDate(day.date)}
                className={`
                  w-8 h-8 mx-auto flex items-center justify-center rounded-full cursor-pointer
                  ${day.isToday ? 'bg-indigo-500 text-white' : 'hover:bg-gray-100'}
                `}
              >
                {day.date.getDate()}
              </div>
              <div className="mt-2 space-y-1">
                {sentenceCount > 0 && (
                  <div className="text-[8px] truncate px-1 py-0.5 rounded bg-emerald-100 text-emerald-700 font-bold">
                    📖 {sentenceCount}句
                  </div>
                )}
                {day.events.slice(0, sentenceCount > 0 ? 2 : 3).map(event => (
                  <div
                    key={event.id}
                    onClick={() => handleEditEvent(event)}
                    className="text-[8px] truncate px-1 py-0.5 rounded cursor-pointer hover:opacity-80"
                    style={{ backgroundColor: event.color + '20', color: event.color }}
                  >
                    {formatEventTime(event.start)} {event.title}
                  </div>
                ))}
              </div>
            </div>
          )});
          console.log(`📅 [Calendar] 周视图渲染: 起始 ${getLocalDateString(weekDays[0]?.date || today)} | 匹配日期: ${weekMatchedDates.length > 0 ? weekMatchedDates.join(', ') : '(无)'}`);
          return weekNodes;
        })()}
      </div>
      )}

      {viewMode === 'day' && (
        <div className="space-y-2 max-h-[300px] overflow-y-auto">
          {selectedDate && (() => {
            const dateStr = getLocalDateString(selectedDate);
            const daySentences = scheduledSentenceMap.get(dateStr);
            console.log(`📅 [Calendar] 日视图渲染: ${dateStr} | 预定句子: ${daySentences?.length || 0}句${daySentences ? ' → [' + daySentences.map(s => s.english.slice(0, 25)).join(' | ') + ']' : ''} | 日程: ${dayEvents.length}个`);
            if (!daySentences || daySentences.length === 0) return null;
            return (
              <div className="space-y-2 mb-3">
                <div className="text-[10px] font-bold text-emerald-600 px-1">
                  📖 预定学习句子 ({daySentences.length}句)
                </div>
                {daySentences.map(s => (
                  <div
                    key={s.id}
                    className="flex items-center gap-3 p-3 rounded-xl bg-emerald-50/60"
                    style={{ borderLeft: '4px solid #10b981' }}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-bold text-gray-900 truncate">{s.english}</div>
                      <div className="text-xs text-gray-500 mt-0.5 truncate">{s.chinese}</div>
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}
          {dayEvents.length === 0 ? (
            <div className="text-center py-8 text-gray-600 text-sm">
              无日程安排
            </div>
          ) : (
            dayEvents.map(event => (
              <div
                key={event.id}
                onClick={() => handleEditEvent(event)}
                className="flex items-center gap-3 p-3 rounded-xl cursor-pointer hover:bg-gray-50 transition-colors"
                style={{ borderLeft: `4px solid ${event.color}` }}
              >
                <div className="text-xs font-bold text-gray-600 w-14">
                  {event.allDay ? '全天' : formatEventTime(event.start)}
                </div>
                <div className="flex-1">
                  <div className="text-sm font-bold text-gray-900">{event.title}</div>
                  {event.description && (
                    <div className="text-xs text-gray-600 mt-0.5">{event.description}</div>
                  )}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteEvent(event.id);
                  }}
                  className="p-1 text-gray-600 hover:text-red-500 transition-colors"
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {showEventModal && (
        <EventModal
          event={editingEvent}
          selectedDate={selectedDate}
          onSave={handleSaveEvent}
          onClose={() => {
            setShowEventModal(false);
            setEditingEvent(null);
          }}
        />
      )}
    </div>
  );
};

interface EventModalProps {
  event: ScheduleEvent | null;
  selectedDate: Date | null;
  onSave: (data: Partial<ScheduleEvent>) => void;
  onClose: () => void;
}

const EventModal: React.FC<EventModalProps> = ({ event, selectedDate, onSave, onClose }) => {
  const [title, setTitle] = useState(event?.title || '');
  const [description, setDescription] = useState(event?.description || '');
  const [startDate, setStartDate] = useState(
    event ? formatEventDate(event.start) : formatEventDate(selectedDate?.getTime() || Date.now())
  );
  const [startTime, setStartTime] = useState(
    event ? formatEventTime(event.start) : '09:00'
  );
  const [endTime, setEndTime] = useState(
    event ? formatEventTime(event.end) : '10:00'
  );
  const [allDay, setAllDay] = useState(event?.allDay || false);
  const [color, setColor] = useState(event?.color || '#3B82F6');
  const [repeat, setRepeat] = useState<RepeatConfig>(event?.repeat || { type: 'none', interval: 1 });
  const [reminder, setReminder] = useState(event?.reminder?.minutesBefore || 15);
  const [linkedMetric, setLinkedMetric] = useState(event?.linkedMetricId || '');

  const handleSave = () => {
    const startDateTime = new Date(`${startDate}T${allDay ? '00:00' : startTime}`);
    const endDateTime = new Date(`${startDate}T${allDay ? '23:59' : endTime}`);
    
    onSave({
      title: title || '新事件',
      description,
      start: startDateTime.getTime(),
      end: endDateTime.getTime(),
      allDay,
      color,
      repeat: repeat.type !== 'none' ? repeat : undefined,
      reminder: { enabled: true, minutesBefore: reminder },
      linkedMetricId: linkedMetric || undefined,
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-3xl p-6 w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-lg font-black text-gray-900">
            {event ? '编辑事件' : '新建事件'}
          </h3>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-full">
            ✕
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-xs font-bold text-gray-600 mb-1 block">标题</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="事件标题"
              className="w-full px-4 py-3 bg-gray-50 rounded-xl border-none focus:ring-2 focus:ring-indigo-200 outline-none"
            />
          </div>

          <div>
            <label className="text-xs font-bold text-gray-600 mb-1 block">描述</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="事件描述（可选）"
              rows={2}
              className="w-full px-4 py-3 bg-gray-50 rounded-xl border-none focus:ring-2 focus:ring-indigo-200 outline-none resize-none"
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="allDay"
              checked={allDay}
              onChange={(e) => setAllDay(e.target.checked)}
              className="w-4 h-4 rounded"
            />
            <label htmlFor="allDay" className="text-sm text-gray-700">全天事件</label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-bold text-gray-600 mb-1 block">日期</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full px-4 py-3 bg-gray-50 rounded-xl border-none focus:ring-2 focus:ring-indigo-200 outline-none"
              />
            </div>
            {!allDay && (
              <>
                <div>
                  <label className="text-xs font-bold text-gray-600 mb-1 block">开始</label>
                  <input
                    type="time"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    className="w-full px-4 py-3 bg-gray-50 rounded-xl border-none focus:ring-2 focus:ring-indigo-200 outline-none"
                  />
                </div>
                <div>
                  <label className="text-xs font-bold text-gray-600 mb-1 block">结束</label>
                  <input
                    type="time"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    className="w-full px-4 py-3 bg-gray-50 rounded-xl border-none focus:ring-2 focus:ring-indigo-200 outline-none"
                  />
                </div>
              </>
            )}
          </div>

          <div>
            <label className="text-xs font-bold text-gray-600 mb-2 block">颜色</label>
            <div className="flex gap-2 flex-wrap">
              {EVENT_COLORS.map(c => (
                <button
                  key={c.value}
                  onClick={() => setColor(c.value)}
                  className={`w-8 h-8 rounded-full transition-transform ${
                    color === c.value ? 'ring-2 ring-offset-2 ring-gray-400 scale-110' : ''
                  }`}
                  style={{ backgroundColor: c.value }}
                />
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs font-bold text-gray-600 mb-1 block">重复</label>
            <select
              value={repeat.type}
              onChange={(e) => setRepeat({ ...repeat, type: e.target.value as RepeatConfig['type'] })}
              className="w-full px-4 py-3 bg-gray-50 rounded-xl border-none focus:ring-2 focus:ring-indigo-200 outline-none"
            >
              <option value="none">不重复</option>
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
              <option value="monthly">每月</option>
              <option value="yearly">每年</option>
            </select>
          </div>

          <div>
            <label className="text-xs font-bold text-gray-600 mb-1 block">提醒</label>
            <select
              value={reminder}
              onChange={(e) => setReminder(Number(e.target.value))}
              className="w-full px-4 py-3 bg-gray-50 rounded-xl border-none focus:ring-2 focus:ring-indigo-200 outline-none"
            >
              {REMINDER_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs font-bold text-gray-600 mb-1 block">关联数据指标</label>
            <select
              value={linkedMetric}
              onChange={(e) => setLinkedMetric(e.target.value)}
              className="w-full px-4 py-3 bg-gray-50 rounded-xl border-none focus:ring-2 focus:ring-indigo-200 outline-none"
            >
              <option value="">无关联</option>
              {METRICS.map(m => (
                <option key={m.id} value={m.id}>{m.icon} {m.name}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex gap-3 mt-6">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-3 bg-gray-100 text-gray-700 font-bold rounded-xl hover:bg-gray-200 transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            className="flex-1 px-4 py-3 bg-indigo-500 text-white font-bold rounded-xl hover:bg-indigo-600 transition-colors"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
};

export default Calendar;
