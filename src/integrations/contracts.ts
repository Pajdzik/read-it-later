export interface IntegrationConfiguration {
  id: string;
  name: string;
  description: string;
  configured: boolean;
  destination: string;
  /** Public configuration identity, checked again on delivery. Never a credential. */
  destinationKey: string;
  message?: string;
}

export interface IntegrationStatus extends IntegrationConfiguration {
  state: "not_saved" | "saved" | "outdated";
  deliveredAt?: string;
  url?: string;
}

export interface IntegrationConsent {
  id: string;
  destinationKey: string;
}

