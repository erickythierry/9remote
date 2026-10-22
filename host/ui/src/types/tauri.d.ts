interface Window {
  __TAURI__?: {
    window?: {
      getCurrentWindow?: () => {
        setTheme?: (theme: string) => Promise<void>;
        setBackgroundColor?: (color: string) => Promise<void>;
        setTitle: (title: string) => Promise<void>;
      };
    };
  };
}
