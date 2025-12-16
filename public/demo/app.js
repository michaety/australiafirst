// Demo UI JavaScript

const API_BASE = '/api/v1';

let allPoliticians = [];
let selectedPolitician = null;

// Load meta information
async function loadMeta() {
  try {
    const response = await fetch(`${API_BASE}/meta.json`);
    const data = await response.json();
    document.getElementById('framework-version').textContent = data.frameworkVersion;
  } catch (e) {
    console.error('Failed to load meta:', e);
  }
}

// Load categories
async function loadCategories() {
  try {
    const response = await fetch(`${API_BASE}/categories.json`);
    const data = await response.json();
    
    const container = document.getElementById('categories-list');
    container.className = 'categories-grid';
    container.innerHTML = data.categories.map(cat => `
      <div class="category-card">
        <h3>${cat.name}</h3>
        <p>${cat.description}</p>
      </div>
    `).join('');
  } catch (e) {
    console.error('Failed to load categories:', e);
    document.getElementById('categories-list').innerHTML = '<p class="error">Failed to load categories</p>';
  }
}

// Load politicians
async function loadPoliticians(filters = {}) {
  try {
    const params = new URLSearchParams();
    if (filters.chamber) params.set('chamber', filters.chamber);
    if (filters.search) params.set('q', filters.search);
    
    const response = await fetch(`${API_BASE}/politicians.json?${params}`);
    const data = await response.json();
    
    allPoliticians = data.politicians;
    renderPoliticians(allPoliticians);
  } catch (e) {
    console.error('Failed to load politicians:', e);
    document.getElementById('politicians-list').innerHTML = '<p class="error">Failed to load politicians</p>';
  }
}

// Render politicians list
function renderPoliticians(politicians) {
  const container = document.getElementById('politicians-list');
  
  if (politicians.length === 0) {
    container.innerHTML = '<p>No politicians found</p>';
    return;
  }
  
  container.className = 'politicians-grid';
  container.innerHTML = politicians.map(p => {
    const score = p.overall ? p.overall.score_0_100 : null;
    const coverage = p.overall ? p.overall.coverage : null;
    
    return `
      <div class="politician-card" data-id="${p.id}">
        <h3>${p.name}</h3>
        <div class="politician-meta">
          ${p.party || 'Independent'} • ${p.seat || 'N/A'}<br>
          ${p.chamber === 'house' ? 'House of Representatives' : 'Senate'}
        </div>
        ${score !== null ? `
          <div class="score-display">
            <strong>Overall Alignment: ${score}/100</strong>
            <div class="score-bar">
              <div class="score-fill" style="width: ${score}%"></div>
            </div>
            <small>Coverage: ${coverage}%</small>
          </div>
        ` : '<p><em>No scores available yet</em></p>'}
      </div>
    `;
  }).join('');
  
  // Add click handlers
  document.querySelectorAll('.politician-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.dataset.id;
      showPoliticianDetail(id);
    });
  });
}

// Show politician detail
async function showPoliticianDetail(id) {
  try {
    document.getElementById('politicians').style.display = 'none';
    document.getElementById('filters').style.display = 'none';
    document.getElementById('categories').style.display = 'none';
    document.getElementById('politician-detail').style.display = 'block';
    
    const response = await fetch(`${API_BASE}/politicians/${id}.json`);
    const data = await response.json();
    const p = data.politician;
    
    let html = `
      <h2>${p.name}</h2>
      <div class="politician-meta">
        ${p.party || 'Independent'} • ${p.seat || 'N/A'}<br>
        ${p.chamber === 'house' ? 'House of Representatives' : 'Senate'}
      </div>
    `;
    
    if (p.overall) {
      html += `
        <div class="score-display">
          <h3>Overall Alignment: ${p.overall.score_0_100}/100</h3>
          <div class="score-bar">
            <div class="score-fill" style="width: ${p.overall.score_0_100}%"></div>
          </div>
          <small>Coverage: ${p.overall.coverage}%</small>
        </div>
      `;
    }
    
    if (p.categoryScores && Object.keys(p.categoryScores).length > 0) {
      html += '<h3>Category Scores</h3>';
      for (const [slug, score] of Object.entries(p.categoryScores)) {
        html += `
          <div class="score-display">
            <strong>${slug.replace(/-/g, ' ')}:</strong> ${score.score_0_100}/100
            <div class="score-bar">
              <div class="score-fill" style="width: ${score.score_0_100}%"></div>
            </div>
            <small>Coverage: ${score.coverage}%</small>
          </div>
        `;
      }
    }
    
    // Load evidence for first category (if any)
    if (p.categoryScores && Object.keys(p.categoryScores).length > 0) {
      const firstCategory = Object.keys(p.categoryScores)[0];
      const evidenceResponse = await fetch(`${API_BASE}/politicians/${id}/evidence.json?category=${firstCategory}&limit=10`);
      const evidenceData = await evidenceResponse.json();
      
      if (evidenceData.items.length > 0) {
        html += '<h3>Recent Evidence</h3>';
        html += '<ul class="evidence-list">';
        evidenceData.items.forEach(item => {
          html += `
            <li class="evidence-item">
              <h4>${item.title}</h4>
              <div class="evidence-meta">
                ${item.date} • 
                <span class="vote-badge vote-${item.vote.toLowerCase()}">${item.vote}</span>
                • Effect: ${item.effect > 0 ? '+' : ''}${item.effect.toFixed(1)}
              </div>
              <p>${item.rationale || 'No rationale provided'}</p>
            </li>
          `;
        });
        html += '</ul>';
      }
    }
    
    document.getElementById('detail-content').innerHTML = html;
  } catch (e) {
    console.error('Failed to load politician detail:', e);
    document.getElementById('detail-content').innerHTML = '<p class="error">Failed to load details</p>';
  }
}

// Back button handler
document.getElementById('back-button').addEventListener('click', () => {
  document.getElementById('politician-detail').style.display = 'none';
  document.getElementById('politicians').style.display = 'block';
  document.getElementById('filters').style.display = 'block';
  document.getElementById('categories').style.display = 'block';
});

// Filter handlers
document.getElementById('chamber-filter').addEventListener('change', (e) => {
  loadPoliticians({ chamber: e.target.value });
});

document.getElementById('search-filter').addEventListener('input', (e) => {
  const search = e.target.value.toLowerCase();
  if (search.length === 0) {
    renderPoliticians(allPoliticians);
  } else {
    const filtered = allPoliticians.filter(p => 
      p.name.toLowerCase().includes(search)
    );
    renderPoliticians(filtered);
  }
});

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadMeta();
  loadCategories();
  loadPoliticians();
});
