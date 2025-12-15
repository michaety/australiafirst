// OpenAustralia API client

export interface OpenAustraliaConfig {
  apiKey: string;
  baseUrl?: string;
}

export class OpenAustraliaClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(config: OpenAustraliaConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://www.openaustralia.org.au/api';
  }

  private async fetch(endpoint: string, params: Record<string, string> = {}) {
    const url = new URL(endpoint, this.baseUrl);
    url.searchParams.set('key', this.apiKey);
    url.searchParams.set('output', 'js');

    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`OpenAustralia API error: ${response.statusText}`);
    }

    return await response.json();
  }

  async getMPs() {
    return await this.fetch('getMPs');
  }

  async getSenators() {
    return await this.fetch('getSenators');
  }

  async getDivisions(params: {
    type?: 'house' | 'senate';
    date?: string;
    search?: string;
  } = {}) {
    return await this.fetch('getDivisions', params as Record<string, string>);
  }

  async getDivision(params: { id: string }) {
    return await this.fetch('getDivision', params);
  }
}
