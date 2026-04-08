export type RepeatType = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom';

export interface RepeatConfig {
  type: RepeatType;
  interval: number;
  daysOfWeek?: number[];
  endDate?: number;
  count?: number;
}

export interface ReminderConfig {
  enabled: boolean;
  minutesBefore: number;
}

export interface ScheduleEvent {
  id: string;
  title: string;
  description?: string;
  start: number;
  end: number;
  allDay: boolean;
  color: string;
  repeat?: RepeatConfig;
  reminder?: ReminderConfig;
  linkedMetricId?: string;
  linkedMetricValue?: number;
  completed: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CalendarDay {
  date: Date;
  isCurrentMonth: boolean;
  isToday: boolean;
  events: ScheduleEvent[];
}

export interface CalendarWeek {
  days: CalendarDay[];
  weekNumber: number;
}

const STORAGE_KEY = 'schedule_events';

export const generateEventId = (): string => {
  return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
};

export const loadEvents = (): ScheduleEvent[] => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.error('Failed to load events:', e);
  }
  return [];
};

export const saveEvents = (events: ScheduleEvent[]): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
  } catch (e) {
    console.error('Failed to save events:', e);
  }
};

export const createEvent = (data: Partial<ScheduleEvent>): ScheduleEvent => {
  const now = Date.now();
  return {
    id: generateEventId(),
    title: data.title || '新事件',
    description: data.description,
    start: data.start || now,
    end: data.end || now + 3600000,
    allDay: data.allDay || false,
    color: data.color || '#3B82F6',
    repeat: data.repeat,
    reminder: data.reminder,
    linkedMetricId: data.linkedMetricId,
    linkedMetricValue: data.linkedMetricValue,
    completed: data.completed || false,
    createdAt: now,
    updatedAt: now,
  };
};

export const updateEvent = (events: ScheduleEvent[], id: string, data: Partial<ScheduleEvent>): ScheduleEvent[] => {
  return events.map(event => {
    if (event.id === id) {
      return { ...event, ...data, updatedAt: Date.now() };
    }
    return event;
  });
};

export const deleteEvent = (events: ScheduleEvent[], id: string): ScheduleEvent[] => {
  return events.filter(event => event.id !== id);
};

export const getEventsForDate = (events: ScheduleEvent[], date: Date): ScheduleEvent[] => {
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const endOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999).getTime();
  
  return events.filter(event => {
    if (event.start >= startOfDay && event.start <= endOfDay) {
      return true;
    }
    
    if (event.repeat && event.repeat.type !== 'none') {
      return isRepeatingOnDate(event, date);
    }
    
    return false;
  }).sort((a, b) => a.start - b.start);
};

const isRepeatingOnDate = (event: ScheduleEvent, date: Date): boolean => {
  if (!event.repeat || event.repeat.type === 'none') return false;
  
  const eventStart = new Date(event.start);
  const checkDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const eventStartDate = new Date(eventStart.getFullYear(), eventStart.getMonth(), eventStart.getDate());
  
  if (checkDate < eventStartDate) return false;
  
  if (event.repeat.endDate && checkDate.getTime() > event.repeat.endDate) return false;
  
  const diffTime = checkDate.getTime() - eventStartDate.getTime();
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
  
  switch (event.repeat.type) {
    case 'daily':
      return diffDays % event.repeat.interval === 0;
      
    case 'weekly':
      if (event.repeat.daysOfWeek && event.repeat.daysOfWeek.length > 0) {
        return event.repeat.daysOfWeek.includes(checkDate.getDay());
      }
      return diffDays % (7 * event.repeat.interval) === 0;
      
    case 'monthly':
      return checkDate.getDate() === eventStart.getDate() && 
             (checkDate.getMonth() - eventStart.getMonth() + 12 * (checkDate.getFullYear() - eventStart.getFullYear())) % event.repeat.interval === 0;
      
    case 'yearly':
      return checkDate.getDate() === eventStart.getDate() &&
             checkDate.getMonth() === eventStart.getMonth() &&
             (checkDate.getFullYear() - eventStart.getFullYear()) % event.repeat.interval === 0;
      
    default:
      return false;
  }
};

export const generateRecurringInstances = (event: ScheduleEvent, startDate: Date, endDate: Date): ScheduleEvent[] => {
  if (!event.repeat || event.repeat.type === 'none') {
    return [event];
  }
  
  const instances: ScheduleEvent[] = [];
  const current = new Date(startDate);
  const eventStart = new Date(event.start);
  
  while (current <= endDate) {
    if (isRepeatingOnDate(event, current)) {
      const instanceStart = new Date(current);
      instanceStart.setHours(eventStart.getHours(), eventStart.getMinutes(), 0, 0);
      
      const instanceEnd = new Date(instanceStart);
      instanceEnd.setTime(instanceEnd.getTime() + (event.end - event.start));
      
      instances.push({
        ...event,
        id: `${event.id}_${instanceStart.getTime()}`,
        start: instanceStart.getTime(),
        end: instanceEnd.getTime(),
      });
    }
    
    current.setDate(current.getDate() + 1);
  }
  
  return instances;
};

export const getCalendarDays = (events: ScheduleEvent[], year: number, month: number): CalendarDay[] => {
  const days: CalendarDay[] = [];
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const startPadding = firstDay.getDay() === 0 ? 6 : firstDay.getDay() - 1;
  const startDate = new Date(firstDay);
  startDate.setDate(startDate.getDate() - startPadding);
  
  const endPadding = lastDay.getDay() === 0 ? 0 : 7 - lastDay.getDay();
  const endDate = new Date(lastDay);
  endDate.setDate(endDate.getDate() + endPadding);
  
  const current = new Date(startDate);
  while (current <= endDate) {
    const dateCopy = new Date(current);
    days.push({
      date: dateCopy,
      isCurrentMonth: current.getMonth() === month,
      isToday: current.getTime() === today.getTime(),
      events: getEventsForDate(events, current),
    });
    current.setDate(current.getDate() + 1);
  }
  
  return days;
};

export const getCalendarWeeks = (events: ScheduleEvent[], year: number, month: number): CalendarWeek[] => {
  const days = getCalendarDays(events, year, month);
  const weeks: CalendarWeek[] = [];
  
  for (let i = 0; i < days.length; i += 7) {
    const weekDays = days.slice(i, i + 7);
    weeks.push({
      days: weekDays,
      weekNumber: getWeekNumber(weekDays[3].date),
    });
  }
  
  return weeks;
};

const getWeekNumber = (date: Date): number => {
  const firstDayOfYear = new Date(date.getFullYear(), 0, 1);
  const pastDaysOfYear = (date.getTime() - firstDayOfYear.getTime()) / 86400000;
  return Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
};

export const getWeekDays = (events: ScheduleEvent[], date: Date): CalendarDay[] => {
  const days: CalendarDay[] = [];
  const startOfWeek = new Date(date);
  const day = startOfWeek.getDay();
  startOfWeek.setDate(startOfWeek.getDate() - (day === 0 ? 6 : day - 1));
  startOfWeek.setHours(0, 0, 0, 0);
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  for (let i = 0; i < 7; i++) {
    const current = new Date(startOfWeek);
    current.setDate(current.getDate() + i);
    days.push({
      date: current,
      isCurrentMonth: true,
      isToday: current.getTime() === today.getTime(),
      events: getEventsForDate(events, current),
    });
  }
  
  return days;
};

export const formatEventTime = (timestamp: number): string => {
  const date = new Date(timestamp);
  return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
};

export const formatEventDate = (timestamp: number): string => {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
};

export const EVENT_COLORS = [
  { name: '蓝色', value: '#3B82F6' },
  { name: '绿色', value: '#10B981' },
  { name: '紫色', value: '#8B5CF6' },
  { name: '橙色', value: '#F59E0B' },
  { name: '红色', value: '#EF4444' },
  { name: '粉色', value: '#EC4899' },
  { name: '青色', value: '#06B6D4' },
  { name: '灰色', value: '#6B7280' },
];

export const REMINDER_OPTIONS = [
  { label: '事件开始时', value: 0 },
  { label: '5分钟前', value: 5 },
  { label: '15分钟前', value: 15 },
  { label: '30分钟前', value: 30 },
  { label: '1小时前', value: 60 },
  { label: '1天前', value: 1440 },
];
