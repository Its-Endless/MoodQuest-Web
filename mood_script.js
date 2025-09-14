// === Config ===
const webhookUrl = "http://localhost:5678/webhook-test/plan-trip"; // replace with your n8n webhook
const GEOCODE_COUNTRY_HINT = ""; // e.g., "in" for India; leave blank to search globally

// DOM references
const chatContainer = document.getElementById("chat-container");
const promptInput = document.getElementById("userPrompt");
const submitBtn = document.getElementById("submitBtn");
const reEvalBtn = document.getElementById("reEvalBtn");
const themeToggle = document.getElementById("themeToggle");
const body = document.body;

let lastPayload = null;

// ==== Map state ====
let map;            // Leaflet map instance
let markersLayer;   // LayerGroup to manage markers
let userMarker;     // user's current location marker

function ensureMap(lat, lng) {
  if (!map) {
    map = L.map('map', { zoomControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
    markersLayer = L.layerGroup().addTo(map);
  }
  map.setView([lat, lng], 13);

  // Add/update user marker
  if (!userMarker) {
    userMarker = L.marker([lat, lng], { title: 'You are here' }).addTo(map);
  } else {
    userMarker.setLatLng([lat, lng]);
  }
}

function updateMapWithLocations(locs) {
  if (!map || !markersLayer) return;

  // Clear previous POI markers (keep user marker separate)
  markersLayer.clearLayers();

  const bounds = [];

  locs.forEach((p) => {
    if (typeof p.lat !== 'number' || typeof p.lng !== 'number') return;
    const title = p.title || p.name || p.place || 'Location';
    const desc = p.description || p.reason || '';
    const marker = L.marker([p.lat, p.lng], { title });
    marker.bindPopup(`<strong>${escapeHtml(title)}</strong><br>${escapeHtml(desc)}`);
    markersLayer.addLayer(marker);
    bounds.push([p.lat, p.lng]);
  });

  // Include user location if present
  if (userMarker) bounds.push(userMarker.getLatLng());

  if (bounds.length) {
    map.fitBounds(bounds, { padding: [24, 24] });
  }
}

function extractLocationsFromResponse(finalData) {
  // 1) Preferred: finalData.locations = [{ lat, lng, title?, description? }, ...]
  if (Array.isArray(finalData?.locations)) {
    return finalData.locations.filter(p => p && typeof p.lat === 'number' && typeof p.lng === 'number');
  }

  // 2) Fallback: finalData.itinerary[].lat/lng or itinerary[].coordinates
  const out = [];
  if (Array.isArray(finalData?.itinerary)) {
    finalData.itinerary.forEach(step => {
      if (typeof step?.lat === 'number' && typeof step?.lng === 'number') {
        out.push({ lat: step.lat, lng: step.lng, title: step.place, description: step.reason });
      } else if (Array.isArray(step?.coordinates) && step.coordinates.length === 2) {
        const [lat, lng] = step.coordinates;
        if (typeof lat === 'number' && typeof lng === 'number') {
          out.push({ lat, lng, title: step.place, description: step.reason });
        }
      }
    });
  }
  return out;
}

// Try to geocode place strings when no lat/lng provided
async function geocodePlace(q, bias) {
  const params = new URLSearchParams({
    q,
    format: "json",
    addressdetails: "0",
    limit: "1",
    ...(GEOCODE_COUNTRY_HINT ? { countrycodes: GEOCODE_COUNTRY_HINT } : {})
  });
  // optional viewbox bias
  if (bias && typeof bias.lat === "number" && typeof bias.lng === "number") {
    // simple bounding box around user (±0.25 deg ~ ~25km)
    const lat = bias.lat, lng = bias.lng;
    const viewbox = `${lng-0.25},${lat+0.25},${lng+0.25},${lat-0.25}`;
    params.set("viewbox", viewbox);
    params.set("bounded", "1");
  }
  const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  const data = await res.json();
  if (Array.isArray(data) && data[0]) {
    return { lat: Number(data[0].lat), lng: Number(data[0].lon) };
  }
  return null;
}

async function geocodeFromItinerary(itinerary, userBias) {
  const out = [];
  for (const step of itinerary) {
    const label = step.place || step.title || step.name;
    if (!label) continue;
    // small delay to be polite
    /* eslint-disable no-await-in-loop */
    const result = await geocodePlace(label, userBias);
    if (result) {
      out.push({ lat: result.lat, lng: result.lng, title: label, description: step.reason || "" });
    }
    await new Promise(r => setTimeout(r, 300));
    /* eslint-enable no-await-in-loop */
  }
  return out;
}

// Append message to chat
function appendMessage(sender, htmlText) {
  const bubble = document.createElement("div");
  bubble.classList.add("chat-bubble", sender);
  bubble.innerHTML = htmlText;
  chatContainer.appendChild(bubble);
  // force layout then scroll
  requestAnimationFrame(() => {
    chatContainer.scrollTop = chatContainer.scrollHeight;
  });
}

// Robust JSON parsing (handles empty/non-JSON responses)
async function parseJSONSafe(res) {
  const ct = res.headers.get("content-type") || "";
  const text = await res.text(); // read once
  if (!text) return {}; // empty body
  if (ct.includes("application/json")) {
    try { return JSON.parse(text); } catch (e) { return { _raw: text, _parseError: e.message }; }
  }
  // try json anyway
  try { return JSON.parse(text); } catch (e) { return { _raw: text, _parseError: e.message }; }
}

// Call backend
async function sendToWebhook(payload) {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return await parseJSONSafe(res);
  } catch (err) {
    return { error: err.message };
  }
}

// Render itinerary in chat
function formatItinerary(data) {
  if (!data.itinerary) return null;

  let message = "";
  data.itinerary.forEach(step => {
    message += `<div style="margin-bottom: 12px;">
      <strong>Step ${step.step ?? ""}:</strong> ${escapeHtml(step.place ?? "")} ${step.estimated_cost ? `(${escapeHtml(step.estimated_cost)})` : ""}<br>
      <em>Reason:</em> ${escapeHtml(step.reason ?? "")}
    </div>`;
  });
  message += `<div><strong>Total Estimated Cost:</strong> ${escapeHtml(data.total_estimated_cost ?? "")}<br>
  <strong>Time of Day:</strong> ${escapeHtml(data.time_of_day ?? "")}</div>`;
  return message;
}

// Submit flow
submitBtn.addEventListener("click", () => {
  const prompt = promptInput.value.trim();
  if (!prompt) {
    alert("Please enter something!");
    return;
  }

  navigator.geolocation.getCurrentPosition(async (pos) => {
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;

    lastPayload = {
      user_prompt: prompt,
      user_location: { lat, lng },
    };

    // Initialize map (and user marker)
    ensureMap(lat, lng);

    appendMessage("user", escapeHtml(prompt));
    promptInput.value = "";
    submitBtn.disabled = true;
    reEvalBtn.disabled = true;

    // Typing indicator
    const typingBubble = document.createElement("div");
    typingBubble.classList.add("chat-bubble", "bot", "typing");
    typingBubble.textContent = "Typing...";
    chatContainer.appendChild(typingBubble);

    const response = await sendToWebhook(lastPayload);

    // Remove typing indicator
    document.querySelector(".typing")?.remove();

    if (response.error) {
      appendMessage("bot", "Error: " + escapeHtml(response.error));
    } else {
      // Some n8n setups wrap output
      let finalData = response[0]?.response?.body || response;

      if (finalData._parseError) {
        appendMessage("bot", "Error: Failed to parse backend JSON. Showing raw text.");
      }

      const formatted = formatItinerary(finalData);
      if (formatted) {
        appendMessage("bot", formatted);
      } else {
        appendMessage("bot", `<pre>${escapeHtml(JSON.stringify(finalData, null, 2))}</pre>`);
      }

      // Update map with any locations returned by backend, else geocode fallback
      let locs = extractLocationsFromResponse(finalData);
      if (!locs.length && Array.isArray(finalData?.itinerary)) {
        try {
          locs = await geocodeFromItinerary(finalData.itinerary, { lat, lng });
        } catch (e) {
          console.warn("Geocoding failed:", e);
        }
      }
      if (locs.length) updateMapWithLocations(locs);

      reEvalBtn.disabled = false;
    }

    submitBtn.disabled = false;
  }, (err) => {
    alert("Location permission is required to personalize the map: " + err.message);
  });
});

// Re-evaluate
reEvalBtn.addEventListener("click", async () => {
  if (!lastPayload) return;

  appendMessage("user", "Re-evaluating your trip...");

  reEvalBtn.disabled = true;

  const typingBubble = document.createElement("div");
  typingBubble.classList.add("chat-bubble", "bot", "typing");
  typingBubble.textContent = "Typing...";
  chatContainer.appendChild(typingBubble);

  const response = await sendToWebhook(lastPayload);

  // Remove typing indicator
  document.querySelector(".typing")?.remove();

  if (response.error) {
    appendMessage("bot", "Error: " + escapeHtml(response.error));
  } else {
    let finalData = response[0]?.response?.body || response;

    const formatted = formatItinerary(finalData);
    if (formatted) {
      appendMessage("bot", formatted);
    } else {
      appendMessage("bot", `<pre>${escapeHtml(JSON.stringify(finalData, null, 2))}</pre>`);
    }

    let locs = extractLocationsFromResponse(finalData);
    if (!locs.length && Array.isArray(finalData?.itinerary)) {
      try {
        const bias = lastPayload?.user_location;
        locs = await geocodeFromItinerary(finalData.itinerary, bias);
      } catch (e) {
        console.warn("Geocoding failed:", e);
      }
    }
    if (locs.length) updateMapWithLocations(locs);

    reEvalBtn.disabled = false;
  }
});

// Theme toggle
const savedTheme = localStorage.getItem("theme") || "dark";
body.className = savedTheme;
if (themeToggle) themeToggle.textContent = savedTheme === "dark" ? "☀" : "✧";

themeToggle?.addEventListener("click", () => {
  const newTheme = body.classList.contains("dark") ? "light" : "dark";
  body.className = newTheme;
  themeToggle.textContent = newTheme === "dark" ? "☀" : "✦";
  localStorage.setItem("theme", newTheme);
});

// Enter to submit
promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submitBtn.click();
  }
});

// Escape HTML for safe rendering
function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
