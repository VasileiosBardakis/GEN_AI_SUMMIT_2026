declare namespace chrome {
  namespace action {
    const onClicked: {
      addListener(callback: (tab: tabs.Tab) => void): void;
    };
  }

  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
      status?: string;
      active?: boolean;
      windowId?: number;
      lastAccessed?: number;
    }

    interface TabChangeInfo {
      status?: string;
      url?: string;
    }

    function get(tabId: number): Promise<Tab>;
    function query(queryInfo: { active?: boolean; currentWindow?: boolean; url?: string }): Promise<Tab[]>;
    function create(createProperties: { url?: string; active?: boolean }): Promise<Tab>;
    function update(tabId: number, updateProperties: { url?: string; active?: boolean }): Promise<Tab>;
    function sendMessage(
      tabId: number,
      message: unknown,
      options?: { frameId?: number },
    ): Promise<unknown>;

    const onUpdated: {
      addListener(callback: (tabId: number, changeInfo: TabChangeInfo, tab: Tab) => void): void;
      removeListener(callback: (tabId: number, changeInfo: TabChangeInfo, tab: Tab) => void): void;
    };
  }

  namespace runtime {
    const onInstalled: {
      addListener(callback: () => void): void;
    };
  }

  namespace storage {
    interface StorageArea {
      get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    }
    const local: StorageArea;
  }

  namespace scripting {
    interface InjectionResult<T> {
      frameId: number;
      result?: T;
    }

    function executeScript<TArgs extends unknown[], TResult>(
      injection: {
        target: { tabId: number; allFrames?: boolean; frameIds?: number[] };
        func: (...args: TArgs) => TResult | Promise<TResult>;
        args?: TArgs;
      },
    ): Promise<InjectionResult<Awaited<TResult>>[]>;

    function executeScript(
      injection: {
        target: { tabId: number; allFrames?: boolean; frameIds?: number[] };
        files: string[];
      },
    ): Promise<InjectionResult<unknown>[]>;
  }

  namespace windows {
    function update(
      windowId: number,
      updateInfo: { focused?: boolean },
    ): Promise<unknown>;
  }
}
