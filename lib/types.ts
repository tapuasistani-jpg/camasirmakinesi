export type AlertView = {
  id: number;
  asin: string;
  title: string;
  url: string;
  image: string | null;
  price: number;
  listPrice: number | null;
  discount: number;
  marketMedian: number | null;
  verdict: string;
  detail: string;
  createdAt: string | null;
};

export type RecentView = {
  asin: string;
  title: string;
  url: string;
  image: string | null;
  price: number;
  listPrice: number | null;
};

export type LogView = {
  level: string;
  message: string;
  createdAt: string | null;
};

export type Status = {
  ready: boolean;
  message: string;
  page: number;
  search: string;
  productCount: number;
  dealCount: number;
  lastScanAt: string | null;
  lastError: string | null;
  minDiscount: number;
  hasToken: boolean;
  tokenHint: string;
  chatId: string;
  notifySuspicious: boolean;
  urlTemplate: string;
  alerts: AlertView[];
  recent: RecentView[];
  logs: LogView[];
};
