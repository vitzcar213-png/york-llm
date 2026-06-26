/* ==========================================================================
   yOrk LLM - Document Research Studio JavaScript
   IndexedDB Persistence, PDF/DOCX Parsing, Gemini 2.5 Flash API RAG Client,
   and Interactive SVG Mind Map Canvas
   ========================================================================== */

// Set PDF.js worker source from CDN
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// Global Application State
const STATE = {
  db: null,
  sources: [],             // Parsed files array
  activeDoc: null,         // Current viewed document
  activeView: 'reader',    // 'reader', 'pdf', 'notes'
  activeRightTab: 'chat',  // 'chat', 'summarise', 'presentation', 'mindmap'
  notes: { title: 'Workspace Notes', text: '' },
  searchMatches: [],
  currentSearchIndex: -1,
  pdfZoom: 1.0,
  pdfDocRef: null,
  
  // Gemini API Configuration
  api: {
    key: localStorage.getItem('york_gemini_key') || '',
    demoMode: localStorage.getItem('york_demo_mode') !== 'false', // Default to true for Demo experience
    model: localStorage.getItem('york_model') || 'gemini-2.5-flash',
    temperature: parseFloat(localStorage.getItem('york_temperature')) || 0.4,
  },
  
  // Mind Map Interactive State
  mindmap: {
    nodes: [],
    links: [],
    zoom: { x: 0, y: 0, scale: 1 },
    isDraggingCanvas: false,
    dragStart: { x: 0, y: 0 },
    activeDragNode: null,
    selectedNode: null
  },
  
  // Slide Carousel State
  carousel: {
    slides: [],
    currentIndex: 0
  }
};

/* --------------------------------------------------------------------------
   1. IndexedDB Initialization & Management
   -------------------------------------------------------------------------- */
const DB_NAME = 'york_llm_workspace';
const DB_VERSION = 1;

function initDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = (e) => {
      console.error('IndexedDB open error:', e);
      reject(e);
    };
    
    request.onsuccess = (e) => {
      STATE.db = e.target.result;
      resolve(STATE.db);
    };
    
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('sources')) {
        db.createObjectStore('sources', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('workspace')) {
        db.createObjectStore('workspace');
      }
    };
  });
}

function saveSourceToDB(source) {
  return new Promise((resolve, reject) => {
    const transaction = STATE.db.transaction(['sources'], 'readwrite');
    const store = transaction.objectStore('sources');
    const request = store.put(source);
    request.onsuccess = () => resolve();
    request.onerror = (e) => reject(e);
  });
}

function getSourcesFromDB() {
  return new Promise((resolve, reject) => {
    const transaction = STATE.db.transaction(['sources'], 'readonly');
    const store = transaction.objectStore('sources');
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = (e) => reject(e);
  });
}

function deleteSourceFromDB(id) {
  return new Promise((resolve, reject) => {
    const transaction = STATE.db.transaction(['sources'], 'readwrite');
    const store = transaction.objectStore('sources');
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = (e) => reject(e);
  });
}

function clearSourcesFromDB() {
  return new Promise((resolve, reject) => {
    const transaction = STATE.db.transaction(['sources'], 'readwrite');
    const store = transaction.objectStore('sources');
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = (e) => reject(e);
  });
}

function saveNotesToDB() {
  return new Promise((resolve, reject) => {
    const transaction = STATE.db.transaction(['workspace'], 'readwrite');
    const store = transaction.objectStore('workspace');
    store.put(STATE.notes, 'notes_data');
    transaction.oncomplete = () => resolve();
    transaction.onerror = (e) => reject(e);
  });
}

function loadNotesFromDB() {
  return new Promise((resolve) => {
    const transaction = STATE.db.transaction(['workspace'], 'readonly');
    const store = transaction.objectStore('workspace');
    const request = store.get('notes_data');
    request.onsuccess = () => {
      if (request.result) {
        STATE.notes = request.result;
      }
      resolve();
    };
    request.onerror = () => {
      resolve(); // Fallback to empty default
    };
  });
}

/* --------------------------------------------------------------------------
   2. Client-Side Document Import System (PDF, DOCX, TXT)
   -------------------------------------------------------------------------- */
async function handleFilesImport(files) {
  const progressContainer = document.getElementById('parse-progress-container');
  const progressName = document.getElementById('progress-file-name');
  const progressBar = document.getElementById('progress-bar-fill');
  const progressPercent = document.getElementById('progress-percentage');
  
  progressContainer.classList.remove('hidden');
  
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    progressName.innerText = `Parsing: ${file.name}`;
    progressBar.style.width = '0%';
    progressPercent.innerText = '0%';
    
    try {
      let textContent = '';
      let format = '';
      
      const updateProgress = (pct) => {
        progressBar.style.width = `${pct}%`;
        progressPercent.innerText = `${Math.round(pct)}%`;
      };

      const isImage = /\.(png|jpe?g|gif|webp|svg)$/i.test(file.name);
      let sourceDataUrl = null;

      if (file.name.endsWith('.pdf')) {
        format = 'pdf';
        textContent = await parsePDFFile(file, updateProgress);
      } else if (file.name.endsWith('.docx')) {
        format = 'docx';
        textContent = await parseDocxFile(file, updateProgress);
      } else if (file.name.endsWith('.txt') || file.name.endsWith('.md')) {
        format = file.name.endsWith('.md') ? 'md' : 'txt';
        textContent = await parseTextFile(file, updateProgress);
      } else if (isImage) {
        format = file.name.split('.').pop().toLowerCase();
        sourceDataUrl = await readImageAsDataURL(file);
        textContent = await parseImageContent(file, sourceDataUrl, updateProgress);
      } else {
        throw new Error('Unsupported file extension.');
      }
      
      const newSource = {
        id: 'src_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        title: file.name,
        format: format,
        size: formatBytes(file.size),
        text: textContent,
        pages: textContent.split(/\n\s*\n\s*\n|\f/), // Simple split pagination
        dataUrl: sourceDataUrl || null,
        fileBlob: file, // Store raw file Blob for full canvas rendering
        active: true, // Checked in workspace by default
        addedAt: new Date().toISOString()
      };
      
      STATE.sources.push(newSource);
      await saveSourceToDB(newSource);
      
    } catch (err) {
      console.error('Parsing error on file:', file.name, err);
      alert(`Could not parse "${file.name}": ${err.message || err}`);
    }
  }
  
  progressContainer.classList.add('hidden');
  updateUIWorkspace();
}

// PDF Parser using PDF.js
function parsePDFFile(file, progressCallback) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async function() {
      try {
        const typedarray = new Uint8Array(this.result);
        const pdf = await pdfjsLib.getDocument({data: typedarray}).promise;
        const totalPages = pdf.numPages;
        let extractedText = '';
        
        for (let i = 1; i <= totalPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          const pageText = content.items.map(item => item.str).join(' ');
          extractedText += pageText + `\n\n[Page ${i}]\n\f\n`;
          progressCallback((i / totalPages) * 100);
        }
        resolve(extractedText);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = (err) => reject(err);
    reader.readAsArrayBuffer(file);
  });
}

// Word Document Parser using Mammoth.js
function parseDocxFile(file, progressCallback) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async function() {
      try {
        progressCallback(30);
        const arrayBuffer = this.result;
        const result = await mammoth.extractRawText({arrayBuffer: arrayBuffer});
        progressCallback(100);
        resolve(result.value || '');
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = (err) => reject(err);
    reader.readAsArrayBuffer(file);
  });
}

// Standard Text / Markdown Parser
function parseTextFile(file, progressCallback) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = function() {
      progressCallback(100);
      resolve(this.result || '');
    };
    reader.onerror = (err) => reject(err);
    reader.readAsText(file);
  });
}

// Read Image File as Data URL Base64
function readImageAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(file);
  });
}

// Multimodal Image OCR Parser using Gemini 2.5 Flash
async function parseImageContent(file, dataUrl, progressCallback) {
  progressCallback(20);
  
  if (STATE.api.demoMode) {
    progressCallback(60);
    const mockOCR = generateMockImageOCR(file.name);
    progressCallback(100);
    return mockOCR;
  }
  
  const base64Data = dataUrl.split(',')[1];
  const mimeType = dataUrl.split(';')[0].split(':')[1];
  
  progressCallback(40);
  try {
    const model = STATE.api.model || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${STATE.api.key}`;
    
    const payload = {
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Transcribe all visible text in this image, translate if it is not in English, and describe the contents in detail.' },
            {
              inlineData: {
                mimeType: mimeType,
                data: base64Data
              }
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.2
      }
    };
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      throw new Error(`Gemini Multimodal OCR failed: HTTP ${response.status}`);
    }
    
    const data = await response.json();
    progressCallback(90);
    const extractedText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    progressCallback(100);
    return extractedText || `### Visual Image: ${file.name}\n\n*(Could not extract any text from this image)*`;
  } catch (err) {
    console.error('Gemini Image OCR call failed:', err);
    progressCallback(100);
    return `### Visual Image: ${file.name}\n\n*Error running Gemini API OCR: ${err.message || err}*\n\n(Local fallback: Image uploaded and saved locally)`;
  }
}

// Generate high quality mock descriptions for images in Demo Mode
function generateMockImageOCR(filename) {
  const name = filename.toLowerCase();
  let content = `### Visual Image Analysis: ${filename}\n\n`;
  
  if (name.includes('flowchart') || name.includes('diagram') || name.includes('chart')) {
    content += `#### Image Type: System Architecture / Flowchart\n\n**Visual Elements Transcribed:**\n- **Start State**: User inputs search query.\n- **Process Box 1**: Local RAG pipeline matches keywords.\n- **Decision Diamond**: Is API key configured?\n- **Yes path**: Query Gemini Flash 2.5 endpoint with context.\n- **No path**: Run Mock simulation engine.\n- **End State**: Output rendering onto workspace panels.\n\n**Extracted Conceptual Summary:**\nThis diagram describes the client-side parsing and processing pipeline of yOrk LLM. It shows how sources (PDF, DOCX, Images) are imported, parsed using client libraries, cached locally, and referenced dynamically in the right panel insights drawer.`;
  } else if (name.includes('invoice') || name.includes('receipt') || name.includes('bill')) {
    content += `#### Image Type: Financial Invoice Document\n\n**Transcribed Text Content:**\n- **Merchant**: ACME Solutions Corp\n- **Date**: June 26, 2026\n- **Invoice #**: INV-884021\n- **Items Transcribed**:\n  - 1x Gemini Flash API Integration (L3 tier) — $49.00\n  - 1x Interactive SVG Mind Map Library License — $20.00\n  - 3x IndexedDB Persistence Modules — $0.00 (Promo)\n- **Subtotal**: $69.00\n- **Tax (10%)**: $6.90\n- **Total amount due**: $75.90\n\n**Visual Details:**\nReceipt matches standard retail print, thermal paper alignment, clear branding watermark at the top-left section. Signature is verified.`;
  } else if (name.includes('screenshot') || name.includes('ui') || name.includes('dashboard')) {
    content += `#### Image Type: UI Screenshot Layout\n\n**Visual Analysis Details:**\n- **Header Section**: Features a dark layout navbar, profile avatar, and API key connectivity drawer.\n- **Workspace Columns**: Shows Left Side (Source Libraries), Center Workspace (Reader Panel & PDF Page scroll list), and Right Side (AI Synthesis Tools: Chat, Summary, Slides, Mind Maps).\n- **Theme Settings**: Displays Neon accents on deep indigo slate grids, corresponding to yOrk LLM visual themes.`;
  } else {
    content += `#### Image Type: General Image Attachment\n\n**Visual Analysis Summary:**\nThis image shows graphical content related to the workspace research folder.\n\n**Key observations:**\n- **OCR Extracted Labels**: "System Data", "Workspace", "Analysis Matrix".\n- **Description**: The picture contains diagrammatic figures, conceptual node structures, or screenshots. yOrk LLM can chat about this image and use it as reference in RAG queries.`;
  }
  
  return content;
}

// Utility to format bytes
function formatBytes(bytes, decimals = 1) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/* --------------------------------------------------------------------------
   3. Viewer Workspace Rendering (Reader & PDF canvas)
   -------------------------------------------------------------------------- */
function setActiveDocument(source) {
  STATE.activeDoc = source;
  
  const title = document.getElementById('active-document-title');
  const docIcon = document.getElementById('viewer-doc-icon');
  const pdfTab = document.getElementById('pdf-view-tab');
  
  if (!source) {
    title.innerText = 'No document selected';
    docIcon.className = 'doc-icon';
    pdfTab.classList.add('disabled');
    pdfTab.disabled = true;
    
    // Hide viewing containers, show empty state
    document.getElementById('viewer-empty-state').classList.remove('hidden');
    document.getElementById('reader-view-container').classList.add('hidden');
    document.getElementById('pdf-view-container').classList.add('hidden');
    
    // Set active tab to notes if no doc selected, or keep notes
    if (STATE.activeView !== 'notes') {
      setViewTab('reader'); // Shows reader empty state
    }
    return;
  }
  
  title.innerText = source.title;
  
  // Set format class for icon colors
  docIcon.className = `doc-icon ${source.format}`;
  
  // Enable PDF view if pdf format
  if (source.format === 'pdf') {
    pdfTab.classList.remove('disabled');
    pdfTab.disabled = false;
  } else {
    pdfTab.classList.add('disabled');
    pdfTab.disabled = true;
    if (STATE.activeView === 'pdf') {
      setViewTab('reader');
    }
  }
  
  document.getElementById('viewer-empty-state').classList.add('hidden');
  renderDocView();
}

function renderDocView() {
  if (!STATE.activeDoc) return;
  
  const readerPane = document.getElementById('reading-pane');
  const pdfCanvasContainer = document.getElementById('pdf-canvas-list-container');
  
  if (STATE.activeView === 'reader') {
    document.getElementById('reader-view-container').classList.remove('hidden');
    document.getElementById('pdf-view-container').classList.add('hidden');
    document.getElementById('notes-view-container').classList.add('hidden');
    
    if (STATE.activeDoc.dataUrl) {
      // Render image preview container with extracted details underneath
      const extractedHtml = marked.parse(STATE.activeDoc.text);
      readerPane.innerHTML = `
        <div class="viewer-image-preview-wrapper">
          <img src="${STATE.activeDoc.dataUrl}" class="viewer-image-preview" alt="${STATE.activeDoc.title}">
        </div>
        <div class="viewer-image-extraction">
          <div class="list-section-header">Image Transcription & Visual Insights</div>
          <div class="image-transcription-text">${extractedHtml}</div>
        </div>
      `;
    } else {
      // Render text with line breaks
      let htmlContent = STATE.activeDoc.text
        .split('\n')
        .map(line => {
          if (!line.trim()) return '';
          // If line looks like a header
          if (line.match(/^#{1,3}\s/)) {
            const level = line.match(/^#+/)[0].length;
            return `<h${level}>${line.replace(/^#+\s*/, '')}</h${level}>`;
          }
          return `<p>${escapeHTML(line)}</p>`;
        })
        .join('');
        
      readerPane.innerHTML = htmlContent || '<p class="empty-state-text">No text extracted.</p>';
    }
    
    // Clear search highlights
    STATE.searchMatches = [];
    STATE.currentSearchIndex = -1;
    document.getElementById('search-match-count').innerText = '0/0';
    document.getElementById('viewer-search-input').value = '';
    
  } else if (STATE.activeView === 'pdf') {
    document.getElementById('reader-view-container').classList.add('hidden');
    document.getElementById('pdf-view-container').classList.remove('hidden');
    document.getElementById('notes-view-container').classList.add('hidden');
    
    pdfCanvasContainer.innerHTML = '<div class="loader-spinner">Rendering original PDF pages...</div>';
    
    renderOriginalPDFPages();
    
  } else if (STATE.activeView === 'notes') {
    document.getElementById('reader-view-container').classList.add('hidden');
    document.getElementById('pdf-view-container').classList.add('hidden');
    document.getElementById('notes-view-container').classList.remove('hidden');
  }
}

// PDF Canvas renderer (renders real PDF vector pages with images)
async function renderOriginalPDFPages() {
  if (!STATE.activeDoc || STATE.activeDoc.format !== 'pdf') return;
  
  const container = document.getElementById('pdf-canvas-list-container');
  container.innerHTML = '<div class="loader-spinner">Loading PDF structures...</div>';
  
  try {
    let arrayBuffer;
    
    // Check if the source has fileBlob (either directly in memory or loaded from DB)
    if (STATE.activeDoc.fileBlob) {
      arrayBuffer = await STATE.activeDoc.fileBlob.arrayBuffer();
    } else {
      // Fallback: If not in memory, we fetch the source again from DB (to guarantee blob loading)
      const transaction = STATE.db.transaction(['sources'], 'readonly');
      const store = transaction.objectStore('sources');
      const record = await new Promise((resolve, reject) => {
        const req = store.get(STATE.activeDoc.id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = (e) => reject(e);
      });
      
      if (record && record.fileBlob) {
        // Cache it in activeDoc
        STATE.activeDoc.fileBlob = record.fileBlob;
        arrayBuffer = await record.fileBlob.arrayBuffer();
      } else {
        throw new Error('Raw PDF file data is not available in local database.');
      }
    }
    
    container.innerHTML = ''; // Clear loading spinner
    
    const typedarray = new Uint8Array(arrayBuffer);
    const pdfDoc = await pdfjsLib.getDocument({data: typedarray}).promise;
    const totalPages = pdfDoc.numPages;
    
    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      
      const wrapper = document.createElement('div');
      wrapper.className = 'pdf-page-canvas-wrapper';
      wrapper.style.margin = '24px auto';
      wrapper.style.position = 'relative';
      
      const tag = document.createElement('div');
      tag.className = 'pdf-page-number-tag';
      tag.style.position = 'absolute';
      tag.style.top = '-18px';
      tag.style.left = '0';
      tag.style.fontSize = '0.7rem';
      tag.style.color = 'var(--text-tertiary)';
      tag.innerText = `Page ${pageNum} of ${totalPages}`;
      wrapper.appendChild(tag);
      
      const canvas = document.createElement('canvas');
      canvas.style.display = 'block';
      canvas.style.borderRadius = '6px';
      canvas.style.boxShadow = '0 6px 16px rgba(0, 0, 0, 0.08)';
      canvas.style.border = '1px solid var(--border-color)';
      canvas.style.backgroundColor = '#ffffff';
      
      // Calculate viewport scale based on state zoom
      const viewport = page.getViewport({ scale: STATE.pdfZoom * 1.25 });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      
      const ctx = canvas.getContext('2d');
      
      const renderContext = {
        canvasContext: ctx,
        viewport: viewport
      };
      
      // Render page visually
      await page.render(renderContext).promise;
      
      wrapper.appendChild(canvas);
      container.appendChild(wrapper);
    }
  } catch (err) {
    console.error('Error rendering original PDF:', err);
    container.innerHTML = `
      <div style="color: var(--accent-rose); padding: 32px; text-align: center;">
        <h5>Failed to render PDF layout</h5>
        <p style="font-size:0.8rem; color:var(--text-secondary); margin-top:8px;">${err.message || err}</p>
      </div>
    `;
  }
}

function setViewTab(viewName) {
  STATE.activeView = viewName;
  
  // Toggle tab buttons
  document.querySelectorAll('.tab-selectors [data-view]').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-view') === viewName);
  });
  
  renderDocView();
}

function escapeHTML(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  );
}

/* --------------------------------------------------------------------------
   4. Local Viewer Search & Highlighting
   -------------------------------------------------------------------------- */
function performLocalSearch() {
  const query = document.getElementById('viewer-search-input').value.trim();
  const pane = document.getElementById('reading-pane');
  
  if (!query || !STATE.activeDoc) {
    renderDocView(); // Reset highlights
    return;
  }
  
  // Re-render raw text first to reset nodes
  let text = STATE.activeDoc.text;
  
  // Escape regex chars
  const escapedQuery = query.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  const regex = new RegExp(`(${escapedQuery})`, 'gi');
  
  // Build match index positions
  let matchesCount = 0;
  let highlightedText = text.split('\n').map(line => {
    if (!line.trim()) return '';
    
    let isHeader = false;
    let headerLevel = 0;
    if (line.match(/^#{1,3}\s/)) {
      isHeader = true;
      headerLevel = line.match(/^#+/)[0].length;
      line = line.replace(/^#+\s*/, '');
    }
    
    // Replace content
    let replacedLine = escapeHTML(line).replace(regex, (match) => {
      matchesCount++;
      return `<mark id="match-idx-${matchesCount - 1}">${match}</mark>`;
    });
    
    if (isHeader) {
      return `<h${headerLevel}>${replacedLine}</h${headerLevel}>`;
    }
    return `<p>${replacedLine}</p>`;
  }).join('');
  
  pane.innerHTML = highlightedText;
  
  STATE.searchMatches = Array.from(pane.querySelectorAll('mark'));
  STATE.currentSearchIndex = STATE.searchMatches.length > 0 ? 0 : -1;
  
  updateSearchControls();
}

function updateSearchControls() {
  const countSpan = document.getElementById('search-match-count');
  
  if (STATE.currentSearchIndex === -1) {
    countSpan.innerText = '0/0';
    return;
  }
  
  countSpan.innerText = `${STATE.currentSearchIndex + 1}/${STATE.searchMatches.length}`;
  
  // Remove current status
  STATE.searchMatches.forEach(el => el.classList.remove('current-search-match'));
  
  // Highlight active
  const currentMark = STATE.searchMatches[STATE.currentSearchIndex];
  if (currentMark) {
    currentMark.classList.add('current-search-match');
    currentMark.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function navigateSearch(direction) {
  if (STATE.searchMatches.length === 0) return;
  
  if (direction === 'next') {
    STATE.currentSearchIndex = (STATE.currentSearchIndex + 1) % STATE.searchMatches.length;
  } else {
    STATE.currentSearchIndex = (STATE.currentSearchIndex - 1 + STATE.searchMatches.length) % STATE.searchMatches.length;
  }
  
  updateSearchControls();
}

/* --------------------------------------------------------------------------
   5. Interactive SVG Mind Map Canvas Generator
   -------------------------------------------------------------------------- */
function generateInteractiveMindMap() {
  const activeSources = STATE.sources.filter(s => s.active);
  const docCountText = document.getElementById('mindmap-doc-count');
  
  if (activeSources.length === 0) {
    docCountText.innerText = '0 sources mapped';
    document.getElementById('mindmap-empty').classList.remove('hidden');
    document.getElementById('mindmap-svg').classList.add('hidden');
    document.getElementById('concept-detail-drawer').classList.add('hidden');
    return;
  }
  
  docCountText.innerText = `${activeSources.length} source${activeSources.length > 1 ? 's' : ''} mapped`;
  document.getElementById('mindmap-empty').classList.add('hidden');
  document.getElementById('mindmap-svg').classList.remove('hidden');
  
  // Build Mind Map nodes structure based on active documents
  // Core Node (Center) -> Topic Nodes (Files) -> Subtopic Nodes (Key Concepts)
  
  const nodes = [];
  const links = [];
  
  // 1. Add Core Node
  const coreNode = {
    id: 'core_workspace',
    name: 'Workspace Research',
    type: 'core',
    x: 400,
    y: 300,
    r: 14,
    description: 'Central focus of the document synthesis. Select topics around the core to see underlying conceptual networks.'
  };
  nodes.push(coreNode);
  
  // 2. Add Topic Nodes (representing each active file)
  const angleStep = (2 * Math.PI) / activeSources.length;
  
  activeSources.forEach((src, idx) => {
    const angle = idx * angleStep;
    const radius = 150;
    const topicNode = {
      id: `topic_${src.id}`,
      name: src.title.length > 20 ? src.title.substr(0, 18) + '...' : src.title,
      type: 'topic',
      x: 400 + Math.cos(angle) * radius,
      y: 300 + Math.sin(angle) * radius,
      r: 9,
      description: `Source document containing ${src.text.split(' ').length} words. Added on ${new Date(src.addedAt).toLocaleDateString()}.`,
      sourceId: src.id
    };
    nodes.push(topicNode);
    
    // Link core to topic
    links.push({
      source: coreNode.id,
      target: topicNode.id,
      type: 'core-link'
    });
    
    // 3. Add Subtopic Nodes (Concepts parsed from the file content)
    // Extract key terms or generate placeholder key concepts
    const concepts = extractConceptsFromText(src.text, src.title);
    const subangleStep = (2 * Math.PI) / concepts.length;
    
    concepts.forEach((concept, subidx) => {
      const subAngle = angle + (subidx - (concepts.length - 1) / 2) * (0.35); // Radial fan outward
      const subRadius = 240;
      const subtopicNode = {
        id: `subtopic_${src.id}_${subidx}`,
        name: concept.term,
        type: 'subtopic',
        x: 400 + Math.cos(subAngle) * subRadius,
        y: 300 + Math.sin(subAngle) * subRadius,
        r: 6,
        description: concept.def,
        sourceId: src.id
      };
      nodes.push(subtopicNode);
      
      // Link topic to subtopic
      links.push({
        source: topicNode.id,
        target: subtopicNode.id,
        type: 'topic-link'
      });
    });
  });
  
  STATE.mindmap.nodes = nodes;
  STATE.mindmap.links = links;
  
  // Set default Zoom
  STATE.mindmap.zoom = { x: 0, y: 0, scale: 1.0 };
  updateMindMapTransform();
  
  renderMindMapElements();
}

// Simple deterministic concept extractor to generate rich maps offline
function extractConceptsFromText(text, filename) {
  // If we have standard mock nodes based on keywords:
  const baseline = [
    { term: 'Core Themes', def: 'Fundamental repeating arguments, observations, and paradigms running through the document.' },
    { term: 'Methodology', def: 'The systematic, theoretical analysis of the methods applied to a field of study or document source.' },
    { term: 'Conclusions', def: 'Key insights and summary deductions derived from the qualitative or quantitative analyses.' }
  ];
  
  if (text.toLowerCase().includes('quantum')) {
    return [
      { term: 'Wave Function', def: 'A mathematical description of the quantum state of an isolated quantum system.' },
      { term: 'Superposition', def: 'The ability of a quantum system to be in multiple states at the same time until measured.' },
      { term: 'Entanglement', def: 'A phenomenon where particles share physical properties regardless of distance.' }
    ];
  }
  
  if (text.toLowerCase().includes('neural') || text.toLowerCase().includes('intelligence') || text.toLowerCase().includes('api')) {
    return [
      { term: 'Context Windows', def: 'The volume of input tokens an LLM can analyze in a single conversational turn.' },
      { term: 'Flash 2.5 LLM', def: 'A high-performance lightweight LLM optimised for speed, low latency, and parsing operations.' },
      { term: 'System Prompting', def: 'Instructions preset into the assistant before user inputs to enforce guidelines.' }
    ];
  }
  
  // Generate file-specific concepts
  const cleanName = filename.replace(/\.[^/.]+$/, "").replace(/[-_]/g, " ");
  return [
    { term: `${cleanName} Outline`, def: `Direct synthesized concepts outlining the document structures inside ${filename}.` },
    { term: 'Key Assumptions', def: 'Unspoken rules or background premises the document author relies upon.' },
    { term: 'Supporting Evidence', def: 'Data, references, figures, or textual citations backing core statements.' }
  ];
}

// Draw elements into SVG
function renderMindMapElements() {
  const svg = document.getElementById('mindmap-svg');
  const linksGroup = document.getElementById('mindmap-links');
  const nodesGroup = document.getElementById('mindmap-nodes');
  
  linksGroup.innerHTML = '';
  nodesGroup.innerHTML = '';
  
  const { nodes, links } = STATE.mindmap;
  
  // Render Links (Cubic Bezier curve connection lines)
  links.forEach(link => {
    const sourceNode = nodes.find(n => n.id === link.source);
    const targetNode = nodes.find(n => n.id === link.target);
    
    if (sourceNode && targetNode) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('class', `mindmap-link ${link.type}`);
      path.setAttribute('id', `link_${sourceNode.id}_${targetNode.id}`);
      
      // Calculate Bezier path curve
      const midX = (sourceNode.x + targetNode.x) / 2;
      const midY = (sourceNode.y + targetNode.y) / 2;
      
      // Path: M x1 y1 Q midX midY x2 y2 (or direct curve)
      const d = `M ${sourceNode.x} ${sourceNode.y} C ${midX} ${sourceNode.y}, ${midX} ${targetNode.y}, ${targetNode.x} ${targetNode.y}`;
      path.setAttribute('d', d);
      
      linksGroup.appendChild(path);
    }
  });
  
  // Render Nodes
  nodes.forEach(node => {
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const isSelected = STATE.mindmap.selectedNode && STATE.mindmap.selectedNode.id === node.id;
    
    group.setAttribute('class', `mindmap-node ${node.type} ${isSelected ? 'selected' : ''}`);
    group.setAttribute('id', `node_${node.id}`);
    group.setAttribute('transform', `translate(${node.x}, ${node.y})`);
    
    // SVG Circle
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('r', node.r);
    group.appendChild(circle);
    
    // Label Text
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('dx', node.r + 6);
    text.setAttribute('dy', 4);
    text.textContent = node.name;
    group.appendChild(text);
    
    // Mouse Event Listeners for dragging nodes and clicking concepts
    group.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      STATE.mindmap.activeDragNode = node;
      selectConceptNode(node);
    });
    
    group.addEventListener('mouseenter', () => {
      // Hover effect on link highlighting
      links.forEach(lnk => {
        if (lnk.source === node.id || lnk.target === node.id) {
          const path = document.getElementById(`link_${lnk.source}_${lnk.target}`);
          if (path) path.classList.add('selected-link');
        }
      });
    });
    
    group.addEventListener('mouseleave', () => {
      links.forEach(lnk => {
        const path = document.getElementById(`link_${lnk.source}_${lnk.target}`);
        if (path) path.classList.remove('selected-link');
      });
    });
    
    nodesGroup.appendChild(group);
  });
}

function selectConceptNode(node) {
  STATE.mindmap.selectedNode = node;
  
  // Remove selected classes and re-add to correct node group
  document.querySelectorAll('.mindmap-node').forEach(el => el.classList.remove('selected'));
  const el = document.getElementById(`node_${node.id}`);
  if (el) el.classList.add('selected');
  
  const drawer = document.getElementById('concept-detail-drawer');
  const title = document.getElementById('concept-detail-title');
  const desc = document.getElementById('concept-detail-description');
  const assoc = document.getElementById('concept-associated-sources');
  const queryBtn = document.getElementById('concept-query-btn');
  
  title.innerText = node.name;
  desc.innerText = node.description;
  
  // Show source file references
  assoc.innerHTML = '';
  if (node.sourceId) {
    const srcFile = STATE.sources.find(s => s.id === node.sourceId);
    if (srcFile) {
      assoc.innerHTML = `
        <div class="citation-pill" onclick="viewSourceFile('${srcFile.id}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
          </svg>
          ${srcFile.title}
        </div>
      `;
    }
  }
  
  // Configure query action
  queryBtn.onclick = () => {
    STATE.activeRightTab = 'chat';
    updateRightPanelTabs();
    
    const input = document.getElementById('chat-input-field');
    input.value = `Explain the concept of "${node.name}" based on our uploaded document workspace, specifically details concerning: ${node.description}`;
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';
    input.focus();
  };
  
  drawer.classList.remove('hidden');
}

function viewSourceFile(id) {
  const src = STATE.sources.find(s => s.id === id);
  if (src) {
    setActiveDocument(src);
    setViewTab('reader');
  }
}

// Drag canvas and Zoom utilities
function setupMindMapViewportControls() {
  const container = document.getElementById('mindmap-container');
  const svg = document.getElementById('mindmap-svg');
  
  // Mouse Wheel zooming
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomIntensity = 0.08;
    const oldScale = STATE.mindmap.zoom.scale;
    
    if (e.deltaY < 0) {
      STATE.mindmap.zoom.scale = Math.min(2.5, oldScale + zoomIntensity);
    } else {
      STATE.mindmap.zoom.scale = Math.max(0.4, oldScale - zoomIntensity);
    }
    
    updateMindMapTransform();
  });
  
  // Drag canvas to Pan
  svg.addEventListener('mousedown', (e) => {
    if (e.target === svg || e.target.id === 'mindmap-grid-pattern') {
      STATE.mindmap.isDraggingCanvas = true;
      STATE.mindmap.dragStart = { x: e.clientX - STATE.mindmap.zoom.x, y: e.clientY - STATE.mindmap.zoom.y };
    }
  });
  
  window.addEventListener('mousemove', (e) => {
    // 1. Pan canvas drag
    if (STATE.mindmap.isDraggingCanvas) {
      STATE.mindmap.zoom.x = e.clientX - STATE.mindmap.dragStart.x;
      STATE.mindmap.zoom.y = e.clientY - STATE.mindmap.dragStart.y;
      updateMindMapTransform();
    }
    // 2. Drag individual node
    else if (STATE.mindmap.activeDragNode) {
      const node = STATE.mindmap.activeDragNode;
      
      // Calculate raw SVG coordinates from client mouse positions
      const svgRect = svg.getBoundingClientRect();
      
      // Transform client x/y to relative local space considering zoom scale
      const relativeX = (e.clientX - svgRect.left - STATE.mindmap.zoom.x) / STATE.mindmap.zoom.scale;
      const relativeY = (e.clientY - svgRect.top - STATE.mindmap.zoom.y) / STATE.mindmap.zoom.scale;
      
      node.x = relativeX;
      node.y = relativeY;
      
      // Re-draw elements and update links paths dynamically
      renderMindMapElements();
    }
  });
  
  window.addEventListener('mouseup', () => {
    STATE.mindmap.isDraggingCanvas = false;
    STATE.mindmap.activeDragNode = null;
  });
  
  document.getElementById('mindmap-reset-btn').addEventListener('click', () => {
    STATE.mindmap.zoom = { x: 0, y: 0, scale: 1.0 };
    updateMindMapTransform();
  });
  
  document.getElementById('close-concept-drawer').addEventListener('click', () => {
    document.getElementById('concept-detail-drawer').classList.add('hidden');
    STATE.mindmap.selectedNode = null;
    renderMindMapElements();
  });
}

function updateMindMapTransform() {
  const transformGroup = document.getElementById('mindmap-transform-group');
  if (transformGroup) {
    transformGroup.setAttribute('transform', `translate(${STATE.mindmap.zoom.x}, ${STATE.mindmap.zoom.y}) scale(${STATE.mindmap.zoom.scale})`);
  }
}

/* --------------------------------------------------------------------------
   6. Gemini API client connection RAG engine (Flash 2.5)
   -------------------------------------------------------------------------- */
async function callGeminiAPI(prompt, systemInstruction = '', streamCallback = () => {}) {
  // If demo mode is active, simulate a rich response
  if (STATE.api.demoMode) {
    return await simulateMockAIResponse(prompt, systemInstruction, streamCallback);
  }
  
  if (!STATE.api.key) {
    throw new Error('API Key missing. Open Gemini Settings (top right green button) to configure.');
  }
  
  const model = STATE.api.model || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${STATE.api.key}`;
  
  const payload = {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      temperature: STATE.api.temperature,
      maxOutputTokens: 8192
    }
  };
  
  if (systemInstruction) {
    payload.systemInstruction = {
      parts: [{ text: systemInstruction }]
    };
  }
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      const errorJson = await response.json().catch(() => ({}));
      throw new Error(errorJson.error?.message || `HTTP ${response.status} Error`);
    }
    
    const data = await response.json();
    const generatedText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!generatedText) {
      throw new Error('Received empty response from Gemini API.');
    }
    
    // Simulate streaming animation text output
    await animateTextStream(generatedText, streamCallback);
    return generatedText;
    
  } catch (err) {
    console.error('Gemini API call failed:', err);
    throw err;
  }
}

// Build workspace sources RAG context
function getRAGContext() {
  const activeSources = STATE.sources.filter(s => s.active);
  let context = '';
  
  if (activeSources.length > 0) {
    context += `BACKGROUND SOURCES:\n==================================\n`;
    activeSources.forEach((src, idx) => {
      context += `[Source ${idx + 1}] Title: ${src.title}\nFormat: ${src.format.toUpperCase()}\nContent Excerpt:\n${src.text}\n==================================\n\n`;
    });
  }
  
  // Include workspace notes
  if (STATE.notes.text.trim()) {
    context += `WORKSPACE COLLABORATIVE NOTES:\n==================================\n${STATE.notes.text}\n==================================\n\n`;
  }
  
  return context;
}

// Stream writer utility to type out characters
function animateTextStream(fullText, callback) {
  return new Promise((resolve) => {
    let currentIdx = 0;
    const charsPerTick = 6; // Batch characters for speedier typing
    
    function tick() {
      if (currentIdx >= fullText.length) {
        callback(fullText);
        resolve();
        return;
      }
      
      currentIdx += charsPerTick;
      const partialText = fullText.substring(0, currentIdx);
      callback(partialText);
      
      requestAnimationFrame(tick);
    }
    
    tick();
  });
}

// Smart Simulated Mock responses for immediate Demo Mode experience
async function simulateMockAIResponse(prompt, systemInstruction, streamCallback) {
  const activeSources = STATE.sources.filter(s => s.active);
  const titles = activeSources.map(s => s.title).join(', ');
  
  let responseText = '';
  
  // Differentiate response based on action / prompt
  if (prompt.includes('__SYNTHESIZE_SUMMARY__')) {
    responseText = `### Executive Research Synthesis: Workspace Context\n\nThis synthesis encapsulates analysis across your active workspace documents (${titles || 'Workspace Notes'}).\n\n#### 1. Executive Summary\n- **Core Objectives**: The source documents discuss key paradigms surrounding document analysis and system integrations. The primary theme focuses on enabling seamless conceptual visualization (like networks and outlines) paired with conversational LLMs.\n- **Primary Discoveries**: Extracting context dynamically is a vital driver. Client-side processing allows for instant retrieval, avoiding costly database servers while guaranteeing personal data compliance.\n- **Significance**: By indexing sources directly inside IndexedDB and mapping concepts in SVG, researchers get high cognitive comprehension ratios compared to simple reading flows.\n\n#### 2. Key Terms Glossary\n- **RAG (Retrieval-Augmented Generation)**: Injecting targeted paragraphs of external documents into the prompt context to make models ground responses accurately.\n- **SVG Mind Map**: An interactive, lightweight XML vector node diagram allowing drag, zoom, and panning directly inside web browsers.\n- **Context Density**: The percentage of key information parsed per page layout, determining the clarity of synthesis prompts.\n\n#### 3. Critical Concepts & Themes\n- **Workspace Portability**: Operating strictly in-browser avoids complex configurations, loading PDF.js and Mammoth.js to build database-free text pipelines.\n- **AI Groundedness**: Relying strictly on local context limits hallucinations, creating high trust levels in education and research platforms.`;
  } 
  else if (prompt.includes('__BUILD_PRESENTATION__')) {
    responseText = `[SLIDES]
---
[SLIDE 1]
Title: yOrk LLM Research Briefing
Subtitle: Automated workspace insights from sources
Bullets:
- Harnessing client-side RAG models for synthesis
- Interactive SVG layouts maps concepts dynamically
- In-memory database persistence using browser IndexedDB
---
[SLIDE 2]
Title: Core Architecture Paradigms
Subtitle: Behind the client-side parsing pipeline
Bullets:
- PDF.js reads layouts and extracts lines and paragraphs
- Mammoth.js processes structured docx word hierarchies
- Files persist locally, preventing credential leakage
---
[SLIDE 3]
Title: Enhancing Academic Workflows
Subtitle: Insights from yOrk LLM deployment
Bullets:
- Study outlines generate key slides instantly
- SVG vector lines map topics and subtopics
- Notes are actively referenced during chat context lookups
[/SLIDES]

[FAQ]
**Q1: What are the main limitations of client-side RAG systems?**
*A1:* Memory and processing bounds. Large documents (e.g. 500+ pages) may run slow inside browser memory. Pre-slicing text pages preserves performance.

**Q2: How does yOrk LLM secure user API key tokens?**
*A2:* Tokens are stored in browser localStorage. Requests bypass servers, querying Google Generative API endpoints directly.
[/FAQ]`;
  } 
  else {
    // Standard chat responses
    if (activeSources.length === 0 && !STATE.notes.text.trim()) {
      responseText = `I notice you haven't uploaded any documents or written any workspace notes yet! 

To get the most out of **yOrk LLM**:
1. Drag and drop PDF or Word documents into the **Sources** pane on the left.
2. Ensure they are checked.
3. Ask me detailed questions, and I will extract answers grounded strictly in your files!

*Note: You are currently running in **Demo Mode (Mock replies)**. To connect real Gemini Flash 2.5 models, enter your key in the top right dialog.*`;
    } else {
      responseText = `Based on your uploaded source document(s) (${titles || 'Workspace Notes'}), here is a detailed breakdown of your query:

1. **Relevance in Context**: The document text heavily emphasizes this topic [1]. The references indicate key correlations between the core parameters.
2. **Key Quotations**:
   - *"Client-side processing builds highly secure, local workspaces."* [1]
   - *"Visual graphs increase reading retention rates."* [1]
3. **Synthesis & Deductions**:
   - **Performance**: Operating with localized RAG systems reduces latency.
   - **Groundedness**: The uploaded documents explicitly support this conclusion [1].

Is there any specific page or document section you want to deep dive into?`;
    }
  }
  
  // Simulate stream typing
  await animateTextStream(responseText, streamCallback);
  return responseText;
}

// Post-process HTML response and convert [1], [2] tags into clickable inline citations
function formatCitations(htmlText) {
  const activeSources = STATE.sources.filter(s => s.active);
  if (activeSources.length === 0) return htmlText;
  
  return htmlText.replace(/\[(\d+)\]/g, (match, numStr) => {
    const index = parseInt(numStr) - 1;
    if (index >= 0 && index < activeSources.length) {
      const src = activeSources[index];
      return `<span class="inline-citation" onclick="viewCitationSource('${src.id}')" title="Jump to ${src.title}">[${numStr}]</span>`;
    }
    return match;
  });
}

// Global handler to open source and flash viewer on citation click
window.viewCitationSource = function(id) {
  const src = STATE.sources.find(s => s.id === id);
  if (src) {
    setActiveDocument(src);
    setViewTab('reader');
    
    const viewerBody = document.getElementById('viewer-workspace-body');
    if (viewerBody) {
      viewerBody.scrollTop = 0;
    }
    
    // Animate title wrapper as click visual feedback
    const titleArea = document.querySelector('.viewer-title-area');
    if (titleArea) {
      titleArea.style.transform = 'scale(1.05)';
      titleArea.style.transition = 'transform 0.15s ease';
      setTimeout(() => {
        titleArea.style.transform = 'scale(1)';
      }, 200);
    }
  }
};

/* --------------------------------------------------------------------------
   7. Chat Logs, Suggestion Pills, and User Interactions
   -------------------------------------------------------------------------- */
async function sendUserChatMessage() {
  const input = document.getElementById('chat-input-field');
  const query = input.value.trim();
  if (!query) return;
  
  // Add User bubble
  appendChatBubble('user', query);
  input.value = '';
  input.style.height = 'auto'; // Reset text input height
  
  // Setup loading assistant bubble
  const assistantBubble = appendChatBubble('assistant', 'Thinking...');
  const bubbleBody = assistantBubble.querySelector('.bubble-body');
  
  // Add loader styling
  bubbleBody.innerHTML = '<span class="typing-loader"></span>';
  
  try {
    const ragContext = getRAGContext();
    const systemPrompt = `You are yOrk LLM, an expert document intelligence assistant.
Your goal is to answer queries based strictly on the provided context source files.
You MUST cite your assertions inline by placing the source index inside square brackets, e.g. [1] for Source 1, [2] for Source 2, and so on.
If the answer cannot be found in the sources, reply honestly stating so.
${ragContext}`;
    
    const response = await callGeminiAPI(query, systemPrompt, (partialText) => {
      // Stream content callback: parse markdown to HTML on the fly and highlight citations
      let parsedHtml = marked.parse(partialText);
      bubbleBody.innerHTML = formatCitations(parsedHtml);
    });
    
    // Add citation references if sources are attached
    const activeSources = STATE.sources.filter(s => s.active);
    if (activeSources.length > 0) {
      const citationsDiv = document.createElement('div');
      citationsDiv.className = 'source-citations';
      
      activeSources.forEach(src => {
        const citation = document.createElement('div');
        citation.className = 'citation-pill';
        citation.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10" height="10">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
          </svg>
          ${src.title.length > 15 ? src.title.substr(0, 12) + '...' : src.title}
        `;
        citation.onclick = () => {
          setActiveDocument(src);
          setViewTab('reader');
        };
        citationsDiv.appendChild(citation);
      });
      
      bubbleBody.appendChild(citationsDiv);
    }
    
    // Scroll chat to bottom
    const viewport = document.getElementById('chat-logs-viewport');
    viewport.scrollTop = viewport.scrollHeight;
    
  } catch (err) {
    bubbleBody.innerHTML = `
      <div style="color: var(--accent-rose);">
        <strong>Error connecting to Gemini API:</strong><br>
        ${err.message || err}
      </div>
    `;
  }
}

function appendChatBubble(role, content) {
  const container = document.getElementById('chat-logs-viewport');
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${role}-bubble`;
  
  let avatarSvg = '';
  if (role === 'user') {
    avatarSvg = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
        <circle cx="12" cy="7" r="4"></circle>
      </svg>
    `;
  } else {
    avatarSvg = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2a10 10 0 0 1 10 10v4a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h1"></path>
        <path d="M12 2a10 10 0 0 0-10 10v4a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2H2"></path>
      </svg>
    `;
  }
  
  bubble.innerHTML = `
    <div class="bubble-avatar">${avatarSvg}</div>
    <div class="bubble-body">${marked.parse(content)}</div>
  `;
  
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
  return bubble;
}

/* --------------------------------------------------------------------------
   8. Summarize Synthesis Tools
   -------------------------------------------------------------------------- */
async function generateWorkspaceSummary() {
  const activeSources = STATE.sources.filter(s => s.active);
  const output = document.getElementById('summary-output');
  
  if (activeSources.length === 0) {
    alert('Please select at least one active source document on the left panel.');
    return;
  }
  
  output.innerHTML = `
    <div class="tool-empty-state">
      <span class="typing-loader"></span>
      <h5 style="margin-top:12px;">Synthesizing workspace documents...</h5>
    </div>
  `;
  
  try {
    const ragContext = getRAGContext();
    const systemPrompt = `You are a research synthesis AI. Write a comprehensive summary based strictly on the provided documents.`;
    const query = `__SYNTHESIZE_SUMMARY__ Extract executive summary, key definitions glossary, and key concept outlines.`;
    
    await callGeminiAPI(query, systemPrompt, (partialText) => {
      output.innerHTML = marked.parse(partialText);
    });
  } catch (err) {
    output.innerHTML = `
      <div style="color: var(--accent-rose); padding:20px;">
        <strong>Failed to synthesize summary:</strong><br>
        ${err.message || err}
      </div>
    `;
  }
}

/* --------------------------------------------------------------------------
   9. Slide Outline Builder & Presentation Carousel
   -------------------------------------------------------------------------- */
async function generatePresentationSlides() {
  const activeSources = STATE.sources.filter(s => s.active);
  const output = document.getElementById('presentation-output');
  
  if (activeSources.length === 0) {
    alert('Please select at least one active source document on the left panel.');
    return;
  }
  
  output.innerHTML = `
    <div class="tool-empty-state">
      <span class="typing-loader"></span>
      <h5 style="margin-top:12px;">Constructing slide deck and FAQs...</h5>
    </div>
  `;
  
  try {
    const ragContext = getRAGContext();
    const systemPrompt = `You are an educational designer. Format your output strictly using these boundary tags: [SLIDES]...[/SLIDES] and [FAQ]...[/FAQ].
    Inside [SLIDES], define slides separated by '---'. For each slide, write:
    [SLIDE X]
    Title: Slide Title
    Subtitle: Slide Subtitle
    Bullets:
    - Bullet 1
    - Bullet 2`;
    
    const query = `__BUILD_PRESENTATION__ Build a presentation layout with slides and FAQ study outlines.`;
    
    const result = await callGeminiAPI(query, systemPrompt, (partialText) => {
      output.innerHTML = `<div style="font-size:0.8rem; color:var(--text-secondary); white-space:pre-wrap;">${escapeHTML(partialText)}</div>`;
    });
    
    renderSlideOutlineResult(result);
    
  } catch (err) {
    output.innerHTML = `
      <div style="color: var(--accent-rose); padding:20px;">
        <strong>Failed to build outline:</strong><br>
        ${err.message || err}
      </div>
    `;
  }
}

function renderSlideOutlineResult(rawText) {
  const output = document.getElementById('presentation-output');
  output.innerHTML = '';
  
  // Parse Slides section (case-insensitive tags)
  const slideMatch = rawText.match(/\[SLIDES\]([\s\S]*?)\[\/SLIDES\]/i);
  const faqMatch = rawText.match(/\[FAQ\]([\s\S]*?)\[\/FAQ\]/i);
  
  let parsedSlides = [];
  
  if (slideMatch) {
    const slidesRaw = slideMatch[1].split('---');
    
    slidesRaw.forEach((slideText) => {
      const titleMatch = slideText.match(/Title:\s*(.*)/i);
      const subtitleMatch = slideText.match(/Subtitle:\s*(.*)/i);
      const bulletsMatch = slideText.match(/Bullets:([\s\S]*)/i);
      
      if (titleMatch) {
        let bullets = [];
        if (bulletsMatch) {
          bullets = bulletsMatch[1]
            .split('\n')
            .map(line => line.replace(/^-\s*/, '').trim())
            .filter(line => line.length > 0);
        }
        
        parsedSlides.push({
          title: titleMatch[1].trim(),
          subtitle: subtitleMatch ? subtitleMatch[1].trim() : '',
          bullets: bullets
        });
      }
    });
  } else {
    // Fallback: Parse markdown sections beginning with headers
    const sections = rawText.split(/(?=##+\s*(?:Slide|Presentation|Topic|Concept))/i);
    sections.forEach(section => {
      const lines = section.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      if (lines.length > 0) {
        let title = lines[0].replace(/^##+\s*(?:Slide\s*\d*:\s*)?/i, '').trim();
        if (!title || title.toLowerCase().includes('faq') || title.toLowerCase().includes('question') || title.toLowerCase().includes('slides')) return;
        
        let bullets = [];
        let subtitle = '';
        
        lines.slice(1).forEach(line => {
          if (line.match(/^[-*]\s*/)) {
            bullets.push(line.replace(/^[-*]\s*/, '').trim());
          } else if (line.match(/^\d+\.\s*/)) {
            bullets.push(line.replace(/^\d+\.\s*/, '').trim());
          } else if (line.startsWith('*') && line.endsWith('*')) {
            subtitle = line.replace(/^\*+|\*+$/g, '').trim();
          } else if (!subtitle && line.length < 60 && !line.includes('|') && !line.includes(':')) {
            subtitle = line;
          }
        });
        
        if (bullets.length > 0 || title.length > 0) {
          parsedSlides.push({
            title: title || 'Slide Concept',
            subtitle: subtitle || 'Document analysis section',
            bullets: bullets.length > 0 ? bullets : ['Key concept detailed in outline summary']
          });
        }
      }
    });
  }
  
  if (parsedSlides.length === 0) {
    // Emergency fallback slides if parsing failed
    parsedSlides = [
      {
        title: STATE.activeDoc ? STATE.activeDoc.title : 'Research Outline',
        subtitle: 'Key summary findings',
        bullets: ['Slides could not be extracted in standard format', 'Review the detailed text output in study outline details below']
      }
    ];
  }
  
  STATE.carousel.slides = parsedSlides;
  STATE.carousel.currentIndex = 0;
  
  // Create Slide Carousel View
  const carouselContainer = document.createElement('div');
  carouselContainer.className = 'slide-deck-preview';
  carouselContainer.innerHTML = `
    <div class="list-section-header">Presentation Outline</div>
    <div class="slides-carousel">
      <div class="slide-card" id="carousel-slide-card">
        <!-- Populated by updateSlideCarousel -->
      </div>
    </div>
    <div class="carousel-controls">
      <button class="small-icon-btn" id="prev-slide-btn">&larr; Previous</button>
      <span class="carousel-page-indicator" id="carousel-page-indicator">Slide 1 / 1</span>
      <button class="small-icon-btn" id="next-slide-btn">Next &rarr;</button>
    </div>
  `;
  
  output.appendChild(carouselContainer);
  updateSlideCarousel();
  
  // Add event listeners for slide carousel
  document.getElementById('prev-slide-btn').addEventListener('click', () => {
    if (STATE.carousel.slides.length === 0) return;
    STATE.carousel.currentIndex = (STATE.carousel.currentIndex - 1 + STATE.carousel.slides.length) % STATE.carousel.slides.length;
    updateSlideCarousel();
  });
  
  document.getElementById('next-slide-btn').addEventListener('click', () => {
    if (STATE.carousel.slides.length === 0) return;
    STATE.carousel.currentIndex = (STATE.carousel.currentIndex + 1) % STATE.carousel.slides.length;
    updateSlideCarousel();
  });
  
  // Parse FAQs section
  const faqDiv = document.createElement('div');
  faqDiv.className = 'study-faq-section';
  
  if (faqMatch) {
    faqDiv.innerHTML = `
      <div class="list-section-header" style="margin-top:20px;">Study FAQs & Flashcards</div>
      <div id="faq-list-output">
        ${marked.parse(faqMatch[1])}
      </div>
    `;
  } else {
    // If FAQ block is missing, display raw text cleanly formatted below the slide deck
    faqDiv.innerHTML = `
      <div class="list-section-header" style="margin-top:20px;">Detailed Study Outline</div>
      <div id="faq-list-output">
        ${marked.parse(rawText.replace(/\[\/?slides\]/gi, ''))}
      </div>
    `;
  }
  output.appendChild(faqDiv);
}

function updateSlideCarousel() {
  const card = document.getElementById('carousel-slide-card');
  const page = document.getElementById('carousel-page-indicator');
  const slide = STATE.carousel.slides[STATE.carousel.currentIndex];
  
  if (!slide) return;
  
  card.innerHTML = `
    <div class="slide-header">
      <svg class="logo-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
        <path d="M12 2L2 7L12 12L22 7L12 2Z"></path>
      </svg>
      <span class="slide-badge">SLIDE ${STATE.carousel.currentIndex + 1}</span>
    </div>
    <div class="slide-body">
      <div class="slide-title">${escapeHTML(slide.title)}</div>
      <div class="slide-footer" style="color:var(--accent-indigo); margin-top:2px; margin-bottom:12px;">${escapeHTML(slide.subtitle)}</div>
      <ul class="slide-bullets">
        ${slide.bullets.map(b => `<li>${escapeHTML(b)}</li>`).join('')}
      </ul>
    </div>
    <div class="slide-footer">
      <span>yOrk LLM Studio</span>
      <span>${STATE.carousel.currentIndex + 1} / ${STATE.carousel.slides.length}</span>
    </div>
  `;
  
  page.innerText = `Slide ${STATE.carousel.currentIndex + 1} of ${STATE.carousel.slides.length}`;
}

/* --------------------------------------------------------------------------
   10. Core UI Management & Event Handlers
   -------------------------------------------------------------------------- */
function updateUIWorkspace() {
  const countBadge = document.getElementById('source-count-badge');
  const statusBadge = document.getElementById('workspace-status-text');
  const contextIndicator = document.getElementById('chat-context-indicator');
  const sourcesList = document.getElementById('sources-list');
  
  countBadge.innerText = STATE.sources.length;
  
  // Total words
  const totalWords = STATE.sources.reduce((sum, s) => sum + s.text.split(/\s+/).length, 0);
  
  if (STATE.sources.length === 0) {
    statusBadge.innerText = 'Empty Workspace';
    contextIndicator.innerText = 'No sources selected for AI context';
    contextIndicator.classList.remove('active');
    sourcesList.innerHTML = `<div class="empty-state-text small" id="sources-empty-state">No sources added yet. Drag documents here to begin research.</div>`;
    setActiveDocument(null);
    generateInteractiveMindMap();
    return;
  }
  
  statusBadge.innerText = `${STATE.sources.length} document${STATE.sources.length > 1 ? 's' : ''} (${totalWords.toLocaleString()} words)`;
  
  const activeSources = STATE.sources.filter(s => s.active);
  contextIndicator.innerText = `${activeSources.length} of ${STATE.sources.length} sources active in chat`;
  contextIndicator.classList.toggle('active', activeSources.length > 0);
  
  // Re-build sources cards list
  sourcesList.innerHTML = '';
  STATE.sources.forEach(src => {
    const card = document.createElement('div');
    const isViewing = STATE.activeDoc && STATE.activeDoc.id === src.id;
    card.className = `source-card ${isViewing ? 'active-view' : ''}`;
    
    card.innerHTML = `
      <div class="source-checkbox-wrapper" onclick="event.stopPropagation()">
        <input type="checkbox" class="source-checkbox" id="chk_${src.id}" ${src.active ? 'checked' : ''}>
      </div>
      <div class="source-info-wrapper">
        <svg class="source-icon ${src.format}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
        </svg>
        <div class="source-details">
          <span class="source-title" title="${src.title}">${src.title}</span>
          <span class="source-meta">${src.size} &bull; ${src.format.toUpperCase()}</span>
        </div>
      </div>
      <button class="delete-source-btn" title="Remove file" onclick="event.stopPropagation(); removeSourceFile('${src.id}')">
        <svg class="delete-source-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
      </button>
    `;
    
    // Clicking card opens in viewer
    card.addEventListener('click', () => {
      setActiveDocument(src);
    });
    
    // Checkbox toggling active state
    card.querySelector(`.source-checkbox`).addEventListener('change', async (e) => {
      src.active = e.target.checked;
      await saveSourceToDB(src);
      updateUIWorkspace();
      generateInteractiveMindMap();
    });
    
    sourcesList.appendChild(card);
  });
}

async function removeSourceFile(id) {
  if (STATE.activeDoc && STATE.activeDoc.id === id) {
    setActiveDocument(null);
  }
  
  STATE.sources = STATE.sources.filter(s => s.id !== id);
  await deleteSourceFromDB(id);
  
  updateUIWorkspace();
  generateInteractiveMindMap();
}

function updateRightPanelTabs() {
  document.querySelectorAll('[data-right-tab]').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-right-tab') === STATE.activeRightTab);
  });
  
  document.querySelectorAll('.right-tab-content').forEach(content => {
    content.classList.toggle('active', content.id === `${STATE.activeRightTab}-tab-content`);
  });
}

function updateAPIIndicatorButton() {
  const btn = document.getElementById('api-config-btn');
  const keyInput = document.getElementById('api-key-input');
  
  if (STATE.api.demoMode) {
    btn.className = 'api-status-pill connected';
    btn.querySelector('.status-label').innerText = 'Gemini API';
    btn.querySelector('.api-model-badge').innerText = 'Simulated';
  } else if (STATE.api.key) {
    btn.className = 'api-status-pill connected';
    btn.querySelector('.status-label').innerText = 'Gemini API';
    btn.querySelector('.api-model-badge').innerText = STATE.api.model === 'gemini-2.5-pro' ? 'Pro 2.5' : 'Flash 2.5';
  } else {
    btn.className = 'api-status-pill disconnected';
    btn.querySelector('.status-label').innerText = 'Setup Key';
    btn.querySelector('.api-model-badge').innerText = 'Offline';
  }
  
  keyInput.value = STATE.api.key;
  document.getElementById('demo-mode-checkbox').checked = STATE.api.demoMode;
  document.getElementById('model-select').value = STATE.api.model;
  document.getElementById('temperature-slider').value = STATE.api.temperature;
  document.getElementById('temperature-value').innerText = STATE.api.temperature;
}

// Hover text highlighting popup handler
function setupSelectionPopover() {
  const popover = document.getElementById('selection-popover');
  const pane = document.getElementById('reading-pane');
  let selectedText = '';
  
  document.addEventListener('selectionchange', () => {
    const selection = window.getSelection();
    selectedText = selection.toString().trim();
    
    if (!selectedText || !pane.contains(selection.anchorNode)) {
      popover.classList.add('hidden');
      return;
    }
    
    // Get mouse boundaries of selection
    try {
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      
      popover.style.top = `${rect.top - 42 + window.scrollY}px`;
      popover.style.left = `${rect.left + rect.width / 2 - 60 + window.scrollX}px`;
      popover.classList.remove('hidden');
    } catch (e) {
      popover.classList.add('hidden');
    }
  });
  
  document.getElementById('popover-btn-ask').addEventListener('click', () => {
    if (!selectedText) return;
    STATE.activeRightTab = 'chat';
    updateRightPanelTabs();
    
    const input = document.getElementById('chat-input-field');
    input.value = `Regarding this passage in the document:\n"${selectedText}"\n\nMy question is: `;
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';
    input.focus();
    
    window.getSelection().removeAllRanges();
    popover.classList.add('hidden');
  });
  
  document.getElementById('popover-btn-note').addEventListener('click', async () => {
    if (!selectedText) return;
    
    const textarea = document.getElementById('workspace-notes-textarea');
    const divider = STATE.notes.text.trim() ? '\n\n---\n' : '';
    const srcTitle = STATE.activeDoc ? `(From ${STATE.activeDoc.title})` : '';
    
    STATE.notes.text += `${divider}*Excerpt ${srcTitle}:*\n> ${selectedText}`;
    textarea.value = STATE.notes.text;
    
    await saveNotesToDB();
    showNotesSavedFeedback();
    
    window.getSelection().removeAllRanges();
    popover.classList.add('hidden');
  });
}

function showNotesSavedFeedback() {
  const status = document.getElementById('notes-save-status');
  status.innerText = 'Saving...';
  setTimeout(() => {
    status.innerText = 'Saved locally';
  }, 800);
}

// General startup bindings
async function startupInit() {
  // DB
  await initDatabase();
  STATE.sources = await getSourcesFromDB();
  await loadNotesFromDB();
  
  // Bind elements
  updateUIWorkspace();
  generateInteractiveMindMap();
  updateAPIIndicatorButton();
  
  // Set default notes in textarea
  document.getElementById('workspace-notes-textarea').value = STATE.notes.text;
  document.getElementById('notes-title').value = STATE.notes.title;
  
  // Bind click drag drop actions
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  
  dropZone.onclick = () => fileInput.click();
  fileInput.onchange = (e) => handleFilesImport(e.target.files);
  
  dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add('dragover'); };
  dropZone.ondragleave = () => dropZone.classList.remove('dragover');
  dropZone.ondrop = (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files) handleFilesImport(e.dataTransfer.files);
  };
  
  // Clean Workspace sources
  document.getElementById('clear-sources-btn').onclick = async () => {
    if (confirm('Are you sure you want to clear all documents in this workspace? This cannot be undone.')) {
      STATE.sources = [];
      await clearSourcesFromDB();
      updateUIWorkspace();
      generateInteractiveMindMap();
    }
  };
  
  // Config Modal actions
  const configModal = document.getElementById('api-config-modal');
  document.getElementById('api-config-btn').onclick = () => configModal.classList.remove('hidden');
  document.getElementById('close-api-modal').onclick = () => configModal.classList.add('hidden');
  document.getElementById('cancel-api-btn').onclick = () => configModal.classList.add('hidden');
  
  document.getElementById('save-api-btn').onclick = () => {
    const key = document.getElementById('api-key-input').value.trim();
    const demo = document.getElementById('demo-mode-checkbox').checked;
    const model = document.getElementById('model-select').value;
    const temp = parseFloat(document.getElementById('temperature-slider').value);
    
    STATE.api.key = key;
    STATE.api.demoMode = demo;
    STATE.api.model = model;
    STATE.api.temperature = temp;
    
    localStorage.setItem('york_gemini_key', key);
    localStorage.setItem('york_demo_mode', demo);
    localStorage.setItem('york_model', model);
    localStorage.setItem('york_temperature', temp);
    
    updateAPIIndicatorButton();
    configModal.classList.add('hidden');
  };
  
  // Test connection button inside Modal
  document.getElementById('test-api-btn').onclick = async () => {
    const key = document.getElementById('api-key-input').value.trim();
    const demo = document.getElementById('demo-mode-checkbox').checked;
    const statusText = document.getElementById('test-connection-status');
    
    statusText.innerText = 'Testing connection...';
    statusText.className = 'test-status-message testing';
    
    if (demo) {
      setTimeout(() => {
        statusText.innerText = 'Success! Demo Mode Active (Offline)';
        statusText.className = 'test-status-message success';
      }, 600);
      return;
    }
    
    if (!key) {
      statusText.innerText = 'Enter API Key first.';
      statusText.className = 'test-status-message error';
      return;
    }
    
    // Actual small query validation to test key credentials
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'Hello' }] }] })
      });
      
      if (res.ok) {
        statusText.innerText = 'Connection Valid!';
        statusText.className = 'test-status-message success';
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (e) {
      statusText.innerText = `Failed: Verify API Key.`;
      statusText.className = 'test-status-message error';
    }
  };
  
  // Key Visibility Toggle
  document.getElementById('toggle-key-visibility').onclick = function() {
    const input = document.getElementById('api-key-input');
    if (input.type === 'password') {
      input.type = 'text';
      this.innerText = 'Hide';
    } else {
      input.type = 'password';
      this.innerText = 'Show';
    }
  };
  
  // Advanced settings accordion
  document.getElementById('advanced-settings-toggle').onclick = function() {
    this.classList.toggle('active');
    document.getElementById('advanced-settings-content').classList.toggle('hidden');
  };
  
  document.getElementById('temperature-slider').oninput = function() {
    document.getElementById('temperature-value').innerText = this.value;
  };
  
  // Theme Switching binding
  document.getElementById('theme-toggle-btn').onclick = () => {
    document.body.classList.toggle('dark-mode');
    document.body.classList.toggle('light-mode');
  };
  
  // Central tab bindings
  document.querySelectorAll('.tab-selectors [data-view]').forEach(btn => {
    btn.onclick = () => {
      if (btn.disabled || btn.classList.contains('disabled')) return;
      setViewTab(btn.getAttribute('data-view'));
    };
  });
  
  // Right utility tabs bindings
  document.querySelectorAll('[data-right-tab]').forEach(btn => {
    btn.onclick = () => {
      STATE.activeRightTab = btn.getAttribute('data-right-tab');
      updateRightPanelTabs();
      if (STATE.activeRightTab === 'mindmap') {
        generateInteractiveMindMap();
      }
    };
  });
  
  // Reader size controls
  document.getElementById('font-size-decrease').onclick = () => {
    const pane = document.getElementById('reading-pane');
    let size = parseFloat(window.getComputedStyle(pane).fontSize);
    pane.style.fontSize = `${Math.max(12, size - 1)}px`;
  };
  
  document.getElementById('font-size-increase').onclick = () => {
    const pane = document.getElementById('reading-pane');
    let size = parseFloat(window.getComputedStyle(pane).fontSize);
    pane.style.fontSize = `${Math.min(24, size + 1)}px`;
  };
  
  // Reader search bindings
  document.getElementById('viewer-search-input').oninput = performLocalSearch;
  document.getElementById('search-prev-btn').onclick = () => navigateSearch('prev');
  document.getElementById('search-next-btn').onclick = () => navigateSearch('next');
  
  // PDF zoom controls
  document.getElementById('pdf-zoom-out').onclick = () => {
    STATE.pdfZoom = Math.max(0.5, STATE.pdfZoom - 0.1);
    document.getElementById('pdf-zoom-level').innerText = `${Math.round(STATE.pdfZoom * 100)}%`;
    renderOriginalPDFPages();
  };
  
  document.getElementById('pdf-zoom-in').onclick = () => {
    STATE.pdfZoom = Math.min(2.0, STATE.pdfZoom + 0.1);
    document.getElementById('pdf-zoom-level').innerText = `${Math.round(STATE.pdfZoom * 100)}%`;
    renderOriginalPDFPages();
  };
  
  // Notes auto-saving listener
  const textarea = document.getElementById('workspace-notes-textarea');
  textarea.oninput = async (e) => {
    STATE.notes.text = e.target.value;
    await saveNotesToDB();
    showNotesSavedFeedback();
  };
  
  document.getElementById('notes-title').oninput = async (e) => {
    STATE.notes.title = e.target.value;
    await saveNotesToDB();
    showNotesSavedFeedback();
  };
  
  document.getElementById('clear-notes-btn').onclick = async () => {
    if (confirm('Clear all workspace notes?')) {
      STATE.notes.text = '';
      textarea.value = '';
      await saveNotesToDB();
      showNotesSavedFeedback();
    }
  };
  
  // Chat typing sizing adjuster
  const chatInput = document.getElementById('chat-input-field');
  chatInput.oninput = function() {
    this.style.height = 'auto';
    this.style.height = this.scrollHeight + 'px';
  };
  
  chatInput.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendUserChatMessage();
    }
  };
  
  document.getElementById('chat-send-btn').onclick = sendUserChatMessage;
  
  // Starter prompt pills listener
  document.querySelectorAll('.suggestion-pill').forEach(pill => {
    pill.onclick = () => {
      chatInput.value = pill.getAttribute('data-prompt');
      chatInput.focus();
      chatInput.style.height = 'auto';
      chatInput.style.height = chatInput.scrollHeight + 'px';
    };
  });
  
  // Synthesize Summary trigger
  document.getElementById('generate-summary-btn').onclick = generateWorkspaceSummary;
  
  // Build outline trigger
  document.getElementById('generate-presentation-btn').onclick = generatePresentationSlides;
  
  // Map concept button in Mind Map toolbar
  document.getElementById('generate-mindmap-btn').onclick = () => {
    generateInteractiveMindMap();
  };
  
  // Global search input filters documents
  document.getElementById('global-search-input').oninput = function(e) {
    const q = e.target.value.toLowerCase().trim();
    if (!q) {
      updateUIWorkspace();
      return;
    }
    
    // Filter showing cards containing word matches in text
    document.querySelectorAll('.source-card').forEach(card => {
      const srcId = card.querySelector('.source-checkbox').id.replace('chk_', '');
      const src = STATE.sources.find(s => s.id === srcId);
      if (src && (src.title.toLowerCase().includes(q) || src.text.toLowerCase().includes(q))) {
        card.style.display = 'flex';
      } else {
        card.style.display = 'none';
      }
    });
  };
  
  setupSelectionPopover();
  setupMindMapViewportControls();
}

// Expose functions globally for inline HTML event handlers (needed for Vite module bundling)
window.removeSourceFile = removeSourceFile;
window.viewSourceFile = viewSourceFile;

window.onload = startupInit;
