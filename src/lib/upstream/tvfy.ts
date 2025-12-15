// TheyVoteForYou API client

export interface TVFYConfig {
  apiKey?: string;
  baseUrl?: string;
}

export class TVFYClient {
  private apiKey?: string;
  private baseUrl: string;

  constructor(config: TVFYConfig = {}) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://theyvoteforyou.org.au/api/v1';
  }

  private async fetch(endpoint: string) {
    const url = new URL(endpoint, this.baseUrl);
    
    const headers: HeadersInit = {
      'Accept': 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(url.toString(), { headers });
    if (!response.ok) {
      throw new Error(`TVFY API error: ${response.statusText}`);
    }

    return await response.json();
  }

  async getPeople() {
    return await this.fetch('people.json');
  }

  async getPerson(id: string) {
    return await this.fetch(`people/${id}.json`);
  }

  async getPolicies() {
    return await this.fetch('policies.json');
  }

  async getPolicy(id: string) {
    return await this.fetch(`policies/${id}.json`);
  }

  async getDivisions() {
    return await this.fetch('divisions.json');
  }
}
