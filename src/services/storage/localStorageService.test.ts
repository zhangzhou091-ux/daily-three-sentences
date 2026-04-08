import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { localStorageService } from './localStorageService';

describe('localStorageService settings', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('固定 dailyLearnTarget 为 3，并派发设置变更事件', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    const currentSettings = localStorageService.getSettings();

    localStorageService.saveSettings({
      ...currentSettings,
      userName: 'Alice',
      dailyLearnTarget: 9
    });

    const savedSettings = localStorageService.getSettings();
    const event = dispatchSpy.mock.calls[0]?.[0] as CustomEvent | undefined;

    expect(savedSettings.dailyLearnTarget).toBe(3);
    expect(savedSettings.userName).toBe('Alice');
    expect(event?.type).toBe('settingsChanged');
    expect((event?.detail as { dailyLearnTarget?: number }).dailyLearnTarget).toBe(3);
  });

  it('读取旧设置时会归一化非法的 dailyLearnTarget', () => {
    localStorage.setItem('d3s_settings_v3', JSON.stringify({
      userName: 'Legacy User',
      dailyLearnTarget: 99
    }));

    const settings = localStorageService.getSettings();

    expect(settings.userName).toBe('Legacy User');
    expect(settings.dailyLearnTarget).toBe(3);
  });
});
