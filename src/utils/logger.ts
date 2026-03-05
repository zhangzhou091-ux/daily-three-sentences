const isDev = import.meta.env.DEV;

export const logger = {
  error(message: string, ...args: unknown[]) {
    if (isDev) {
      console.error(message, ...args);
    }
  },

  warn(message: string, ...args: unknown[]) {
    if (isDev) {
      console.warn(message, ...args);
    }
  },

  info(message: string, ...args: unknown[]) {
    if (isDev) {
      console.info(message, ...args);
    }
  },

  log(message: string, ...args: unknown[]) {
    if (isDev) {
      console.log(message, ...args);
    }
  }
};
