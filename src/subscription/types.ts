export interface SubscriptionTarget {
  name: string;
  url: string;
  port: number;
  path: string;
}

export interface SubscriptionConfig {
  enabled: boolean;
  preserveDomain: boolean;
  targets: SubscriptionTarget[];
}
