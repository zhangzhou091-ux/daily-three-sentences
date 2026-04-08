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

type ViewMode = 'day' | 'week' | 'month';

const WEEKDAY_NAMES = ['一', '二', '三', '四', '五', '六', '日'];
const MONTH_NAMES = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

export const Calendar: React.FC = () => {
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

  const navigateMonth = (direction: number) => {
    const newDate = new Date(currentDate);
    newDate.setMonth(newDate.getMonth() + direction);
    setCurrentDate(newDate);
  };

  const navigateWeek = (direction: number) => {
    const newDate = new Date(selectedDate || currentDate);
    newDate.setDate(newDate.getDate() + direction * 7);
    setCurrentDate(newDate);
    setSelectedDate(newDate);
  };

  const handleDateClick = (day: CalendarDay) => {
    setSelectedDate(day.date);
    if (viewMode === 'month') {
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
                onClick={() => setViewMode(mode)}
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
          
          {calendarWeeks.map((week, wi) => 
            week.days.map((day, di) => (
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
                {day.events.slice(0, 2).map(event => (
                  <div
                    key={event.id}
                    className="text-[8px] truncate px-1 py-0.5 rounded mb-0.5"
                    style={{ backgroundColor: event.color + '20', color: event.color }}
                  >
                    {event.title}
                  </div>
                ))}
                {day.events.length > 2 && (
                  <div className="text-[8px] text-gray-600 text-center">
                    +{day.events.length - 2}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {viewMode === 'week' && (
        <div className="grid grid-cols-7 gap-2">
          {weekDays.map((day, i) => (
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
                {day.events.slice(0, 3).map(event => (
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
          ))}
        </div>
      )}

      {viewMode === 'day' && (
        <div className="space-y-2 max-h-[300px] overflow-y-auto">
          {dayEvents.length === 0 ? (
            <div className="text-center py-8 text-gray-600 text-sm">
              暂无日程安排
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
