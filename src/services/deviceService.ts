export const deviceService = {
  isMobile: (): boolean => {
    const ua = navigator.userAgent.toLowerCase();
    const isMobileUA = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini|mobile/i.test(ua);
    const isSmallScreen = window.innerWidth <= 768;
    const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    const isIPad = /ipad/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    
    const isMobile = isMobileUA || isIPad || (isSmallScreen && isTouchDevice);
    
    if (import.meta.env.DEV) {
      console.log('📱 设备检测:', {
        ua,
        isMobileUA,
        isSmallScreen,
        isTouchDevice,
        isIPad,
        isMobile
      });
    }
    
    return isMobile;
  },
  isDesktop: (): boolean => !deviceService.isMobile(),
  getDeviceType: (): 'mobile' | 'desktop' => deviceService.isMobile() ? 'mobile' : 'desktop',
  canSubmitFeedback: (): boolean => {
    const result = deviceService.isMobile();
    if (import.meta.env.DEV) {
      console.log('📝 反馈提交权限:', result ? 'mobile' : 'desktop');
    }
    return result;
  },
  canUploadSync: (): boolean => {
    return deviceService.isMobile();
  },
  getSyncMode: (): 'bidirectional' | 'downloadOnly' => {
    return deviceService.isMobile() ? 'bidirectional' : 'downloadOnly';
  },
  getScreenInfo: () => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const isLandscape = width > height;
    
    return {
      width,
      height,
      isLandscape,
      pixelRatio: window.devicePixelRatio || 1,
      aspectRatio: width / height
    };
  }
};
