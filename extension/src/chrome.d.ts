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
    }

    interface TabChangeInfo {
      status?: string;
      url?: string;
    }

    function get(tabId: number): Promise<Tab>;
    function query(queryInfo: { active?: boolean; currentWindow?: boolean }): Promise<Tab[]>;
    function update(tabId: number, updateProperties: { url?: string }): Promise<Tab>;

    const onUpdated: {
      addListener(callback: (tabId: number, changeInfo: TabChangeInfo, tab: Tab) => void): void;
      removeListener(callback: (tabId: number, changeInfo: TabChangeInfo, tab: Tab) => void): void;
    };
  }

  namespace scripting {
    interface InjectionResult<T> {
      frameId: number;
      result?: T;
    }

    function executeScript<TArgs extends unknown[], TResult>(
      injection: {
        target: { tabId: number };
        func: (...args: TArgs) => TResult | Promise<TResult>;
        args?: TArgs;
      },
    ): Promise<InjectionResult<Awaited<TResult>>[]>;
  }
}
