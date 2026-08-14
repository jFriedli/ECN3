/*
 * Front‑end logic for the EzEntry app using the EventCalendar library.
 *
 * This script handles authentication, loads reference data (projects,
 * activities, statuses), initialises the EventCalendar, fetches and
 * displays timesheets from the Bexio API, and manages the creation,
 * editing and deletion of time entries via a modal form.  Users can
 * select a time range to create a new entry, drag or resize events to
 * adjust their duration, and switch between 30‑minute and 15‑minute
 * slots.  A dark mode toggle is provided to switch the calendar theme.
 */

// API endpoints served by the Node backend
const API = {
  projects: '/api/projects',
  activities: '/api/activities',
  statuses: '/api/statuses',
  packages: '/api/packages',
  timesheets: '/api/timesheets',
  contacts: '/api/contacts',
  projectById: '/api/projects',
};

// Global data caches
let calendar = null;
let projects = [];
let activities = [];
let statuses = [];
let packages = [];
// Map of package id to name for quick lookup.  Populated when packages are loaded.
const packageMap = {};
// Store the total hours booked per day for the current view.  Keys are ISO
// dates (YYYY-MM-DD) and values are the number of hours booked on that day.
let dailyTotals = {};
// Default user ID derived from existing timesheets.  When saving a new or
// updated timesheet, include this value to satisfy Bexio's requirement for
// user_id.  It will be set the first time events are fetched.
let defaultUserId = null;

// When true, suppress automatic actions triggered by programmatic
// changes to the project input (such as loading packages or contact
// details).  This prevents duplicate API requests when opening the
// modal pre-fills the project value.
let suppressProjectEvents = false;

// Opens the multi‑day planner modal.  Sets default start and end dates to today
// and selects no activity by default.  Activities will be populated when
// reference data is loaded.
function openMultiModal() {
  const modal = document.getElementById('multi-modal');
  if (!modal) return;
  // Default dates: set start and end to today
  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, '0');
  const d = String(today.getDate()).padStart(2, '0');
  const todayStr = `${y}-${m}-${d}`;
  const startInput = document.getElementById('multi-start-date');
  const endInput = document.getElementById('multi-end-date');
  if (startInput) startInput.value = todayStr;
  if (endInput) endInput.value = todayStr;
  // Clear selected activity
  const actSelect = document.getElementById('multi-activity-select');
  if (actSelect) actSelect.value = '';
  // Show modal
  modal.style.display = 'flex';
}

// Closes the multi‑day planner modal
function closeMultiModal() {
  const modal = document.getElementById('multi-modal');
  if (!modal) return;
  modal.style.display = 'none';
}

// Save multi‑day entries.  Creates a time entry for each weekday between
// the selected start and end dates (inclusive).  Each entry covers
// 08:00–16:00 (8 hours).  Uses the selected activity and the default
// status "Erledigt".  If defaultUserId is known, includes it in the
// payload.
async function saveMultiEntries(event) {
  if (event) event.preventDefault();
  const startVal = document.getElementById('multi-start-date')?.value;
  const endVal = document.getElementById('multi-end-date')?.value;
  const actId = document.getElementById('multi-activity-select')?.value;
  if (!startVal || !endVal || !actId) {
    alert('Please select start date, end date and activity.');
    return;
  }
  const startDate = new Date(startVal);
  const endDate = new Date(endVal);
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    alert('Invalid dates.');
    return;
  }
  if (startDate > endDate) {
    alert('Start date must be on or before end date.');
    return;
  }
  // Determine status ID for "Erledigt" (completed)
  let statusId = '';
  const stat = statuses.find((s) => s.name && s.name.toLowerCase().includes('erledigt'));
  if (stat) {
    statusId = stat.id;
  }
  const entries = [];
  const iter = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  while (iter <= endDate) {
    const dow = iter.getDay();
    // Skip Saturdays (6) and Sundays (0)
    if (dow !== 0 && dow !== 6) {
      // Build ISO strings for 08:00 and 16:00 local time
      const startISO = new Date(iter.getFullYear(), iter.getMonth(), iter.getDate(), 8, 0, 0).toISOString();
      const endISO = new Date(iter.getFullYear(), iter.getMonth(), iter.getDate(), 16, 0, 0).toISOString();
      const payload = {
        pr_project_id: '',
        client_service_id: actId,
        pr_package_id: null,
        status_id: statusId,
        text: '',
        tracking: {
          type: 'range',
          start: startISO,
          end: endISO,
        },
        contact_id: null,
        sub_contact_id: null,
        ...(defaultUserId ? { user_id: defaultUserId } : {}),
      };
      entries.push(payload);
    }
    iter.setDate(iter.getDate() + 1);
  }
  try {
    for (const payload of entries) {
      await fetchJson(API.timesheets, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }
    closeMultiModal();
    // Refresh events after creating multiple entries
    if (calendar) {
      calendar.refetchEvents();
    }
  } catch (err) {
    console.error('Failed to save multi‑day entries:', err);
    alert('Error saving the multi‑day entries. Please try again.');
  }
}

// Scroll the calendar so that midday (approximately 12:00) appears around the
// middle of the view.  This improves usability by positioning the most
// commonly used time slots in the centre when the page loads or when a
// selection is made.  It computes the scroll offset based on the scroll
// height and container height.
function scrollCalendarToMidday() {
  const ecEl = document.getElementById('ec');
  if (!ecEl) return;
  // Delay scrolling slightly to allow the calendar to finish rendering
  setTimeout(() => {
    const maxScroll = ecEl.scrollHeight - ecEl.clientHeight;
    if (maxScroll > 0) {
      ecEl.scrollTop = maxScroll * 0.5;
    }
  }, 100);
}

// Fetch details for a single project, including contact_id and contact_sub_id.
// Returns the project object or null on error.
async function fetchProjectDetails(projectId) {
  if (!projectId) return null;
  try {
    const data = await fetchJson(`${API.projectById}/${projectId}`);
    return data;
  } catch (err) {
    console.error('Failed to fetch project details:', err);
    return null;
  }
}

// Fetch the name of a contact by ID.  Returns the contact name (name_1 and
// optionally name_2) or empty string on error.
async function fetchContactName(contactId) {
  if (!contactId) return '';
  try {
    const data = await fetchJson(`${API.contacts}/${contactId}`);
    // Concatenate name_1 and name_2 if both exist
    let name = '';
    if (data.name_1) name = data.name_1;
    if (data.name_2) name = name ? `${name} ${data.name_2}` : data.name_2;
    return name;
  } catch (err) {
    console.error('Failed to fetch contact name:', err);
    return '';
  }
}

// Utility: fetch JSON from a URL, throwing on non‑OK status
async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status} – ${text}`);
  }
  return await response.json();
}

// Check authentication state.  Returns true if authenticated.
async function checkAuthStatus() {
  try {
    const res = await fetch('/api/authStatus');
    if (!res.ok) return false;
    const json = await res.json();
    return json.authenticated;
  } catch (e) {
    console.error('Failed to check auth status:', e);
    return false;
  }
}

// Populate a <select> element with options from an array.  The labelField
// parameter determines which property of the objects to display as text.
function populateSelect(selectEl, data, labelField) {
  // Clear existing options except the first (placeholder)
  while (selectEl.options.length > 1) {
    selectEl.remove(1);
  }
  data.forEach((item) => {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item[labelField] || item.name || item.title || item.text;
    selectEl.appendChild(option);
  });
}

// Populate the datalist for project search.  Each option's value is the
// project name and has a data‑id attribute with the project ID.
function populateProjectDatalist(datalistEl, data) {
  while (datalistEl.firstChild) {
    datalistEl.removeChild(datalistEl.firstChild);
  }
  data.forEach((item) => {
    const option = document.createElement('option');
    option.value = item.name || item.title || item.text;
    option.setAttribute('data-id', item.id);
    datalistEl.appendChild(option);
  });
}

// Initialise the custom project search with real‑time suggestions.  This
// replaces the native datalist and allows styling similar to Bexio.  It
// filters the global projects array as the user types, displays matching
// projects in a dropdown, and updates the hidden project ID.  When a
// suggestion is chosen, packages and contacts are loaded and default
// activity/status fields are set for new entries.  Clicking outside the
// search hides the suggestions list.
function initProjectSearch() {
  const input = document.getElementById('project-input');
  const suggestionsEl = document.getElementById('project-suggestions');
  const container = document.getElementById('project-search-container');
  if (!input || !suggestionsEl || !container) return;
  // Disable native browser autocomplete/autocorrect features to prevent suggestion overlay
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('spellcheck', 'false');
  input.addEventListener('input', async () => {
    if (suppressProjectEvents) return;
    const query = input.value.toLowerCase();
    suggestionsEl.innerHTML = '';
    if (!query) {
      suggestionsEl.style.display = 'none';
      return;
    }
    // Filter projects by name containing the query
    const matches = projects.filter((p) => (p.name || '').toLowerCase().includes(query)).slice(0, 10);
    if (matches.length === 0) {
      suggestionsEl.style.display = 'none';
      return;
    }
    matches.forEach((proj) => {
      const item = document.createElement('div');
      item.className = 'suggestion-item';
      item.textContent = proj.name || '';
      item.dataset.id = proj.id;
      item.addEventListener('click', async () => {
        // When a suggestion is clicked, populate the input and hidden ID
        suppressProjectEvents = true;
        input.value = proj.name || '';
        document.getElementById('project-id').value = proj.id;
        suggestionsEl.style.display = 'none';
        // Clear existing contact fields
        document.getElementById('contact-name').value = '';
        document.getElementById('sub-contact-name').value = '';
        document.getElementById('contact-id').value = '';
        document.getElementById('sub-contact-id').value = '';
        // Load packages for this project
        await loadPackages(proj.id);
        // Fetch project details to obtain contact IDs
        const projectDetails = await fetchProjectDetails(proj.id);
        if (projectDetails) {
          const cid = projectDetails.contact_id || projectDetails.contactId;
          if (cid) {
            const cname = await fetchContactName(cid);
            document.getElementById('contact-name').value = cname;
            document.getElementById('contact-id').value = cid;
          }
          const scid = projectDetails.sub_contact_id || projectDetails.contact_sub_id || projectDetails.contact_subId || projectDetails.contact_subid;
          if (scid) {
            const scname = await fetchContactName(scid);
            document.getElementById('sub-contact-name').value = scname;
            document.getElementById('sub-contact-id').value = scid;
          }
        }
        // If this is a new entry (no timesheet ID), default the activity and status
        const isNew = !document.getElementById('timesheet-id').value;
        if (isNew) {
          const defaultAct = activities.find((a) => a.name && a.name.toLowerCase().includes('projekt durchf'));
          if (defaultAct) {
            document.getElementById('activity-select').value = defaultAct.id;
          }
          const defaultStat = statuses.find((s) => s.name && s.name.toLowerCase().includes('erledigt'));
          if (defaultStat) {
            document.getElementById('status-select').value = defaultStat.id;
          }
        }
        suppressProjectEvents = false;
        // Trigger blur to invoke any blur event handlers and remove focus
        input.blur();
      });
      suggestionsEl.appendChild(item);
    });
    suggestionsEl.style.display = 'block';
  });
  // Hide suggestions when clicking outside the search container
  document.addEventListener('click', (evt) => {
    if (!container.contains(evt.target)) {
      suggestionsEl.style.display = 'none';
    }
  });
}

// Load and cache the reference data: projects, activities, statuses.
async function loadReferenceData() {
  try {
    const [acts, stats, projs] = await Promise.all([
      fetchJson(API.activities),
      fetchJson(API.statuses),
      fetchJson(API.projects),
    ]);
    activities = acts;
    statuses = stats;
    projects = projs;
    populateSelect(document.getElementById('activity-select'), activities, 'name');
    populateSelect(document.getElementById('status-select'), statuses, 'name');
    // Populate the activity select in the multi‑day planner modal if present
    const multiActSelect = document.getElementById('multi-activity-select');
    if (multiActSelect) {
      populateSelect(multiActSelect, activities, 'name');
    }
    // Populate datalist for backward compatibility if present
    const dl = document.getElementById('project-list');
    if (dl) {
      populateProjectDatalist(dl, projects);
    }
    // Initialise custom search suggestions for projects
    initProjectSearch();
  } catch (err) {
    console.error('Failed to load reference data:', err);
  }
}

// Load packages for a given project ID and populate the package select.
async function loadPackages(projectId) {
  const pkgSelect = document.getElementById('package-select');
  // If there is no package select (e.g. in the multi‑day planner), do nothing
  if (!pkgSelect) {
    packages = [];
    return;
  }
  // Clear existing options except placeholder
  while (pkgSelect.options.length > 1) {
    pkgSelect.remove(1);
  }
  if (!projectId) {
    packages = [];
    return;
  }
  try {
    const data = await fetchJson(`${API.packages}?project_id=${projectId}`);
    // Remove duplicates by id
    const unique = {};
    data.forEach((pkg) => {
      unique[pkg.id] = pkg;
    });
    packages = Object.values(unique);
    // Update global packageMap with this project's packages
    packages.forEach((pkg) => {
      packageMap[pkg.id] = pkg.name || pkg.title;
    });
    packages.forEach((pkg) => {
      const option = document.createElement('option');
      option.value = pkg.id;
      option.textContent = pkg.name || pkg.title;
      pkgSelect.appendChild(option);
    });
  } catch (err) {
    console.error('Failed to load packages:', err);
    packages = [];
  }
}

// Format a JavaScript Date object into 'YYYY-MM-DD HH:MM' in local time.
function formatDateTimeForInput(date) {
  if (!date) return '';
  const d = new Date(date);
  const year = d.getFullYear();
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  const hours = d.getHours().toString().padStart(2, '0');
  const minutes = d.getMinutes().toString().padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

// Format a date to 'DD.MM.YYYY' for display.  Uses the user's locale
// (English UK) so that month and day ordering is consistent.  Pads
// components to two digits.
function formatDateDisplay(date) {
  const d = new Date(date);
  const day = d.getDate().toString().padStart(2, '0');
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const year = d.getFullYear();
  return `${day}.${month}.${year}`;
}

function formatLocalDate(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseDurationHours(duration) {
  if (typeof duration === 'number') return Number.isFinite(duration) ? duration : null;
  if (typeof duration !== 'string') return null;
  if (duration.includes(':')) {
    const match = duration.match(/^(\d+):(\d{1,2})$/);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    return minutes < 60 ? hours + minutes / 60 : null;
  }
  const hours = Number(duration);
  return Number.isFinite(hours) ? hours : null;
}

// Transform a Bexio timesheet into an EventCalendar event object.
function timesheetToEvent(ts) {
  let start = ts?.tracking?.start || ts?.tracking?.date;
  // Guard against missing or invalid start dates
  if (!start) {
    return null;
  }
  const startDateObj = new Date(start);
  if (isNaN(startDateObj.getTime())) {
    return null;
  }
  let end = ts?.tracking?.end || null;
  // If end is missing but duration exists, compute end
  if (!end && ts?.tracking?.duration) {
    const durationHours = parseDurationHours(ts.tracking.duration);
    if (durationHours !== null) {
      const endDate = new Date(startDateObj.getTime() + durationHours * 3600 * 1000);
      if (!isNaN(endDate.getTime())) {
        // toISOString() can throw if the date is invalid or out of range
        try {
          end = endDate.toISOString();
        } catch (e) {
          end = null;
        }
      }
    }
  } else if (end) {
    // Validate end date
    const endObj = new Date(end);
    if (isNaN(endObj.getTime())) {
      end = null;
    }
  }
  const project = projects.find((p) => p.id === ts.pr_project_id);
  let title = '';
  if (project) {
    title = project.name || '';
  }
  // Append work package name if available
  const pkgId = ts.pr_package_id;
  if (pkgId && packageMap[pkgId]) {
    title = title ? `${title} – ${packageMap[pkgId]}` : packageMap[pkgId];
  }
  // Fallback to text if no project title
  if (!title) {
    title = ts.text || 'Time entry';
  }
  return {
    id: ts.id,
    title,
    start: start,
    end: end,
    editable: true,
    extendedProps: {
      project_id: ts.pr_project_id || '',
      client_service_id: ts.client_service_id || '',
      pr_package_id: ts.pr_package_id || '',
      status_id: ts.status_id || '',
      remark: ts.text || '',
    },
  };
}

// Fetch events within a date range (provided by EventCalendar) and supply
// them to the calendar.  `fetchInfo` has properties start, end, startStr,
// endStr (end is exclusive).  We convert the exclusive end to an
// inclusive end_date for the API.
async function fetchEvents(fetchInfo) {
  try {
    const startDate = new Date(fetchInfo.start);
    const endDate = new Date(fetchInfo.end.getTime() - 1);
    const startStr = formatLocalDate(startDate);
    const endStr = formatLocalDate(endDate);
    const timesheets = await fetchJson(`${API.timesheets}?start_date=${startStr}&end_date=${endStr}`);
    if (!Array.isArray(timesheets)) {
      throw new TypeError('Expected /api/timesheets to return an array');
    }
    // Determine the default user ID from the returned timesheets if not already set.
    try {
      if (!defaultUserId && Array.isArray(timesheets) && timesheets.length > 0) {
        // Find the first numeric user_id in the array.  Bexio timesheets
        // typically include user_id as a number identifying the user who
        // created the entry.  Using the first one ensures we have a valid
        // default for subsequent POST/PUT requests.
        for (const ts of timesheets) {
          const uid = ts.user_id;
          if (uid !== undefined && uid !== null && !isNaN(parseInt(uid))) {
            defaultUserId = uid;
            break;
          }
        }
      }
    } catch (e) {
      // ignore errors setting defaultUserId
    }
    let events = timesheets
      .map(timesheetToEvent)
      .filter((ev) => ev && ev.start);
    // Compute daily total hours for this range.  Reset totals first.
    dailyTotals = {};
    timesheets.forEach((ts) => {
        let startStr = ts?.tracking?.start || ts?.tracking?.date;
        if (!startStr) return;
        const startDateObj = new Date(startStr);
        if (isNaN(startDateObj.getTime())) return;
        // Build a date key using local date parts so totals align with visible days
        const y = startDateObj.getFullYear();
        const m = String(startDateObj.getMonth() + 1).padStart(2, '0');
        const d = String(startDateObj.getDate()).padStart(2, '0');
        const dateKey = `${y}-${m}-${d}`;
        // Determine duration in hours
        let durationHours = 0;
        if (ts?.tracking?.end) {
          const endDateObj = new Date(ts.tracking.end);
          if (!isNaN(endDateObj.getTime())) {
            durationHours = (endDateObj - startDateObj) / (1000 * 60 * 60);
          }
        } else if (ts?.tracking?.duration) {
          const parsedDuration = parseDurationHours(ts.tracking.duration);
          if (parsedDuration !== null) durationHours = parsedDuration;
        }
        if (!dailyTotals[dateKey]) dailyTotals[dateKey] = 0;
        dailyTotals[dateKey] += durationHours;
    });
    // Add background events to highlight working hours (08:00–17:00).  Adjust
    // start and end hours by the user's timezone offset so that the shaded area
    // appears at 08–17 local time even when EventCalendar displays times in UTC.
    try {
      const workingEvents = [];
      const currentDay = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
      const endInclusive = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
      while (currentDay <= endInclusive) {
        const y = currentDay.getFullYear();
        const mIndex = currentDay.getMonth();
        const d = currentDay.getDate();
        // Use local time 08:00–17:00 for shading.  No timezone shift needed
        // because Date constructor uses local time zone.  When converted to
        // ISO strings, EventCalendar will place the shaded area at the
        // correct local times.
        // Use plain local datetime strings (without Z) to ensure shading appears from 08:00–17:00 local time.
        // Build ISO strings for 08:00–17:00 local time using Date objects.  When
        // converted via toISOString(), the resulting strings include the
        // timezone offset, ensuring the shaded area appears at the correct
        // local times even when EventCalendar interprets times as UTC.
        // Build local time strings for 08:00 and 17:00 without converting
        // to UTC.  EventCalendar interprets ISO strings without a trailing
        // 'Z' as local time, so using this format ensures the shading
        // appears at the correct local hours (08:00–17:00).
        const month = String(mIndex + 1).padStart(2, '0');
        const day = String(d).padStart(2, '0');
        const startISO = `${y}-${month}-${day}T08:00:00`;
        const endISO = `${y}-${month}-${day}T17:00:00`;
        workingEvents.push({
          id: `work-${y}-${month}-${day}`,
          start: startISO,
          end: endISO,
          display: 'background',
          // Use a slightly lighter colour than the dark calendar background
          backgroundColor: '#3a3a3a',
          editable: false,
        });
        currentDay.setDate(currentDay.getDate() + 1);
      }
      events = workingEvents.concat(events);
    } catch (err) {
      console.warn('Error creating working hour backgrounds:', err);
    }
    // Update the day header before providing events to the calendar
    updateDayHeader();
    return events;
  } catch (err) {
    console.error('Failed to fetch events:', err);
    throw err;
  }
}

// Open the modal for creating or editing a timesheet.  The `data`
// parameter includes id, start, end, project_id, client_service_id,
// pr_package_id, status_id and remark.
async function openModal(data) {
  // Populate form fields
  document.getElementById('timesheet-id').value = data.id || '';
  document.getElementById('start-time').value = formatDateTimeForInput(data.start);
  document.getElementById('end-time').value = formatDateTimeForInput(data.end);
  // Set project input and hidden ID.  Suppress events so that programmatic
  // changes do not trigger package loading and contact fetch twice.
  suppressProjectEvents = true;
  const project = projects.find((p) => p.id === data.project_id);
  document.getElementById('project-input').value = project ? (project.name || project.title || '') : '';
  document.getElementById('project-id').value = data.project_id || '';
  // Load packages for selected project and wait for completion.  This ensures
  // the package select options are available before setting its value.
  await loadPackages(data.project_id);
  // Load project details to populate customer and contact person names.  Clear
  // fields by default.
  document.getElementById('contact-name').value = '';
  document.getElementById('sub-contact-name').value = '';
  document.getElementById('contact-id').value = '';
  document.getElementById('sub-contact-id').value = '';
  if (data.project_id) {
    const projectDetails = await fetchProjectDetails(data.project_id);
    if (projectDetails) {
      // Contact (customer)
      const cid = projectDetails.contact_id || projectDetails.contactId;
      if (cid) {
        const cname = await fetchContactName(cid);
        document.getElementById('contact-name').value = cname;
        document.getElementById('contact-id').value = cid;
      }
      // Contact person (sub contact)
      const scid = projectDetails.sub_contact_id || projectDetails.contact_sub_id || projectDetails.contact_subId || projectDetails.contact_subid;
      if (scid) {
        const scname = await fetchContactName(scid);
        document.getElementById('sub-contact-name').value = scname;
        document.getElementById('sub-contact-id').value = scid;
      }
    }
  }
  // Set activity, package, status selects after packages have loaded
  document.getElementById('activity-select').value = data.client_service_id || '';
  document.getElementById('package-select').value = data.pr_package_id || '';
  document.getElementById('status-select').value = data.status_id || '';
  document.getElementById('remark-input').value = data.remark || '';
  // Show delete button only when editing an existing entry
  const deleteBtn = document.getElementById('delete-btn');
  if (data.id) {
    deleteBtn.style.display = 'inline-block';
  } else {
    deleteBtn.style.display = 'none';
  }
  // Show modal
  const modal = document.getElementById('event-modal');
  modal.style.display = 'flex';

  // Re-enable project input events now that programmatic changes are done
  suppressProjectEvents = false;
}

// Close and hide the modal
function closeModal() {
  const modal = document.getElementById('event-modal');
  modal.style.display = 'none';
}

// Save a timesheet (create or update) based on form values
async function saveTimesheet(event) {
  event.preventDefault();
  const id = document.getElementById('timesheet-id').value;
  const startStr = document.getElementById('start-time').value.trim();
  const endStr = document.getElementById('end-time').value.trim();
  const projectId = document.getElementById('project-id').value;
  const clientServiceId = document.getElementById('activity-select').value;
  const packageId = document.getElementById('package-select').value;
  const statusId = document.getElementById('status-select').value;
  const remark = document.getElementById('remark-input').value.trim();
  const contactIdVal = document.getElementById('contact-id').value;
  const subContactIdVal = document.getElementById('sub-contact-id').value;
  // Require start and end times, activity and status.  Project is optional.
  if (!startStr || !endStr || !clientServiceId || !statusId) {
    alert('Please specify start and end time, activity and status.');
    return;
  }
  // Convert local datetime strings to ISO
  const startIso = new Date(startStr.replace(' ', 'T')).toISOString();
  const endIso = new Date(endStr.replace(' ', 'T')).toISOString();
  const payload = {
    pr_project_id: projectId,
    client_service_id: clientServiceId,
    pr_package_id: packageId || null,
    status_id: statusId,
    text: remark,
    tracking: {
      type: 'range',
      start: startIso,
      end: endIso,
    },
    // Include contact and sub contact IDs if present.  Use contact_sub_id for
    // the secondary contact (contact person) as per Bexio API.
    contact_id: contactIdVal || null,
    sub_contact_id: subContactIdVal || null,
    // If we have derived a default user ID, include it in the payload.  This
    // satisfies Bexio's requirement for a numeric user_id when creating or
    // updating timesheets.  If defaultUserId is null, omit the property to
    // allow the server fallback to apply.
    ...(defaultUserId ? { user_id: defaultUserId } : {}),
  };
  try {
    if (id) {
      // Update existing timesheet.  According to Bexio API docs, editing a timesheet
      // is done via POST to /timesheet/{id}, not PUT.  See documentation.
      await fetchJson(`${API.timesheets}/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } else {
      // Create new timesheet
      await fetchJson(API.timesheets, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }
    closeModal();
    // Refresh events in calendar
    if (calendar) {
      calendar.refetchEvents();
    }
    } catch (err) {
    console.error('Failed to save timesheet:', err);
    alert('Error saving the entry. Please try again.');
  }
}

// Delete a timesheet by ID
async function deleteTimesheet() {
  const id = document.getElementById('timesheet-id').value;
  if (!id) return;
  if (!confirm('Really delete this entry?')) return;
  try {
    await fetch(`/api/timesheets/${id}`, { method: 'DELETE' });
    closeModal();
    if (calendar) {
      calendar.refetchEvents();
    }
  } catch (err) {
    console.error('Failed to delete timesheet:', err);
    alert('Error deleting the entry.');
  }
}

// Update the current range label above the calendar
function updateCurrentRange() {
  if (!calendar) return;
  const view = calendar.getView();
  const start = view.currentStart;
  // End is exclusive; subtract one day to get inclusive end
  const end = new Date(view.currentEnd.getTime() - 1);
  document.getElementById('current-range').textContent = `${formatDateDisplay(start)} – ${formatDateDisplay(end)}`;
}

// Initialises the EventCalendar and binds UI controls
function initCalendar() {
  const calendarEl = document.getElementById('ec');
  // Destroy existing calendar if reinitialising
  if (calendar) {
    EventCalendar.destroy(calendar);
    calendar = null;
  }
  // Use a fixed slot duration of 15 minutes (00:15:00) for all views.
  const slotDur = '00:15:00';
  // Choose a reasonable slot label interval: show labels every 30 minutes by default,
  // except when the slot duration is 60 minutes, then use 60 minutes.
  // Show slot labels every 30 minutes regardless of slot duration for better readability.
  const slotLabelInterval = '00:30:00';
  calendar = EventCalendar.create(calendarEl, {
    view: 'timeGridWeek',
    editable: true,
    selectable: true,
    slotDuration: slotDur,
    snapDuration: slotDur,
    slotLabelInterval: slotLabelInterval,
    // Reduce the row height so that more hours fit on screen.  The default
    // height is 24px; using a smaller value (e.g. 18) makes the calendar
    // appear smaller without scaling the entire page.
    slotHeight: 18,
    // Scroll so that midday (12:00) is roughly centred in the visible area.  Setting
    // scrollTime to 06:00 positions the 12:00 slot near the centre of the scroll container.
    scrollTime: '06:00:00',
    headerToolbar: false,
    // Hide Saturday (6) and Sunday (0) from the week view
    hiddenDays: [0, 6],
    // Use eventSources with a custom events function.  EventCalendar expects either
    // an array of events or an event source; by providing this function here,
    // the calendar will fetch events asynchronously without throwing errors.
    eventSources: [
      { events: fetchEvents }
    ],
    select: (info) => {
      // open modal with default values
      openModal({
        id: null,
        start: info.start,
        end: info.end,
        project_id: '',
        client_service_id: '',
        pr_package_id: '',
        status_id: '',
        remark: '',
      });
      // After selecting a slot, scroll so midday (12:00) is roughly centred
      if (calendar) {
        calendar.setOption('scrollTime', '06:00:00');
      }
      // Also explicitly scroll the calendar container to mid height
      scrollCalendarToMidday();
    },
    eventClick: (info) => {
      const ev = info.event;
      openModal({
        id: ev.id,
        start: ev.start,
        end: ev.end,
        project_id: ev.extendedProps.project_id || '',
        client_service_id: ev.extendedProps.client_service_id || '',
        pr_package_id: ev.extendedProps.pr_package_id || '',
        status_id: ev.extendedProps.status_id || '',
        remark: ev.extendedProps.remark || '',
      });
    },
    eventDrop: async (info) => {
      // Called when an event is moved to a different time
      const ev = info.event;
      const id = ev.id;
      const payload = {
        pr_project_id: ev.extendedProps.project_id || '',
        client_service_id: ev.extendedProps.client_service_id || '',
        pr_package_id: ev.extendedProps.pr_package_id || '',
        status_id: ev.extendedProps.status_id || '',
        text: ev.extendedProps.remark || '',
        tracking: {
          type: 'range',
          start: ev.start.toISOString(),
          end: ev.end ? ev.end.toISOString() : null,
        },
        // Include default user ID if available
        ...(defaultUserId ? { user_id: defaultUserId } : {}),
      };
      try {
        // Use POST to update existing timesheet as per Bexio API.
        await fetchJson(`${API.timesheets}/${id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        console.error('Failed to update timesheet during drag:', err);
        alert('Error updating the entry. The move has been reverted.');
        info.revert();
      }
    },
    eventResize: async (info) => {
      // Called when an event is resized
      const ev = info.event;
      const id = ev.id;
      const payload = {
        pr_project_id: ev.extendedProps.project_id || '',
        client_service_id: ev.extendedProps.client_service_id || '',
        pr_package_id: ev.extendedProps.pr_package_id || '',
        status_id: ev.extendedProps.status_id || '',
        text: ev.extendedProps.remark || '',
        tracking: {
          type: 'range',
          start: ev.start.toISOString(),
          end: ev.end ? ev.end.toISOString() : null,
        },
        // Include default user ID if available
        ...(defaultUserId ? { user_id: defaultUserId } : {}),
      };
      try {
        // Use POST to update existing timesheet as per Bexio API.
        await fetchJson(`${API.timesheets}/${id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        console.error('Failed to update timesheet during resize:', err);
        alert('Error updating the entry. The resize has been reverted.');
        info.revert();
      }
    },
    // Apply a subtle border to events to improve separation when many overlap
    eventDidMount: (info) => {
      try {
        info.el.style.border = '1px solid #555';
        info.el.style.borderRadius = '3px';
      } catch (_) {
        // ignore styling errors
      }
    },
    // When the visible date range changes (e.g. navigating weeks), update the day header
    datesSet: () => {
      updateDayHeader();
      // Scroll to midday to keep the calendar centred when changing weeks
      scrollCalendarToMidday();
    },
  });
  updateCurrentRange();
  // Scroll to midday after initialisation
  scrollCalendarToMidday();
}

// Update the custom day header row with the visible dates and their total booked hours.
function updateDayHeader() {
  const headerEl = document.getElementById('day-header');
  if (!headerEl || !calendar) return;
  const view = calendar.getView();
  // currentStart is inclusive; currentEnd is exclusive; subtract one day from currentEnd
  const start = new Date(view.currentStart);
  const end = new Date(view.currentEnd.getTime() - 1);
  const cells = [];
  const iter = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  while (iter <= end) {
    const dow = iter.getDay();
    if (dow !== 0 && dow !== 6) {
      const dayLabel = iter.toLocaleDateString('de-CH', { weekday: 'short' });
      const dayNum = iter.getDate().toString().padStart(2, '0');
      const monthNum = (iter.getMonth() + 1).toString().padStart(2, '0');
      // Build a local date key to match dailyTotals keys
      const y = iter.getFullYear();
      const m = String(iter.getMonth() + 1).padStart(2, '0');
      const d = String(iter.getDate()).padStart(2, '0');
      const dateKey = `${y}-${m}-${d}`;
      const totalHours = dailyTotals[dateKey] || 0;
      const totalText = totalHours ? `${parseFloat(totalHours.toFixed(2))}h` : '';
      cells.push(`<div class="day-header-cell"><div class="day-date">${dayLabel} ${dayNum}.${monthNum}</div><div class="day-total">${totalText}</div></div>`);
    }
    iter.setDate(iter.getDate() + 1);
  }
  headerEl.innerHTML = cells.join('');
}

// Set up event listeners for UI controls
function bindUI() {
  // Week navigation
  document.getElementById('prev-btn').addEventListener('click', () => {
    if (calendar) {
      calendar.prev();
      updateCurrentRange();
    }
  });
  document.getElementById('next-btn').addEventListener('click', () => {
    if (calendar) {
      calendar.next();
      updateCurrentRange();
    }
  });
  document.getElementById('today-btn').addEventListener('click', () => {
    if (calendar) {
      calendar.setOption('date', new Date());
      updateCurrentRange();
    }
  });

  // Multi‑day planner button opens the multi‑day modal
  const multiBtn = document.getElementById('multi-day-btn');
  if (multiBtn) {
    multiBtn.addEventListener('click', () => {
      openMultiModal();
    });
  }
  // Cancel button in multi‑day modal closes it
  const multiCancel = document.getElementById('multi-cancel-btn');
  if (multiCancel) {
    multiCancel.addEventListener('click', (e) => {
      e.preventDefault();
      closeMultiModal();
    });
  }
  // Handle submission of multi‑day entries
  const multiForm = document.getElementById('multi-form');
  if (multiForm) {
    multiForm.addEventListener('submit', saveMultiEntries);
  }
  // Project input interactions
  const projectInput = document.getElementById('project-input');
  projectInput.addEventListener('change', (e) => {
    // Skip if programmatic change
    if (suppressProjectEvents) return;
    const val = e.target.value.trim();
    // Lookup the project by exact name (case‑insensitive) instead of relying on a datalist
    let matchedId = '';
    const proj = projects.find((p) => (p.name || '').toLowerCase() === val.toLowerCase());
    if (proj) {
      matchedId = proj.id;
    }
    document.getElementById('project-id').value = matchedId;
    // Load packages for selected project
    loadPackages(matchedId);
    // Load project details and populate contact fields
    (async () => {
      document.getElementById('contact-name').value = '';
      document.getElementById('sub-contact-name').value = '';
      document.getElementById('contact-id').value = '';
      document.getElementById('sub-contact-id').value = '';
      if (matchedId) {
        const projectDetails = await fetchProjectDetails(matchedId);
        if (projectDetails) {
          const cid = projectDetails.contact_id || projectDetails.contactId;
          if (cid) {
            const cname = await fetchContactName(cid);
            document.getElementById('contact-name').value = cname;
            document.getElementById('contact-id').value = cid;
          }
          const scid = projectDetails.sub_contact_id || projectDetails.contact_sub_id || projectDetails.contact_subId || projectDetails.contact_subid;
          if (scid) {
            const scname = await fetchContactName(scid);
            document.getElementById('sub-contact-name').value = scname;
            document.getElementById('sub-contact-id').value = scid;
          }
        }
      }
      // If this is a new entry (no timesheet id), set default activity and status
      const isNew = !document.getElementById('timesheet-id').value;
      if (isNew) {
        // Default activity: Projekt Durchführung (case-insensitive)
        const defaultAct = activities.find((a) => a.name && a.name.toLowerCase().includes('projekt durchf'));
        if (defaultAct) {
          document.getElementById('activity-select').value = defaultAct.id;
        }
        // Default status: Erledigt (case-insensitive)
        const defaultStat = statuses.find((s) => s.name && s.name.toLowerCase().includes('erledigt'));
        if (defaultStat) {
          document.getElementById('status-select').value = defaultStat.id;
        }
      }
    })();
  });
  // When the project input loses focus, ensure hidden ID matches typed value
  projectInput.addEventListener('blur', (e) => {
    // Skip if programmatic change
    if (suppressProjectEvents) return;
    const val = e.target.value.trim();
    // Lookup the project by exact name (case‑insensitive) instead of using a datalist
    let matchedId = '';
    const proj = projects.find((p) => (p.name || '').toLowerCase() === val.toLowerCase());
    if (proj) {
      matchedId = proj.id;
    }
    document.getElementById('project-id').value = matchedId;
    loadPackages(matchedId);
    // Also refresh contact fields when leaving input
    (async () => {
      document.getElementById('contact-name').value = '';
      document.getElementById('sub-contact-name').value = '';
      document.getElementById('contact-id').value = '';
      document.getElementById('sub-contact-id').value = '';
      if (matchedId) {
        const projectDetails = await fetchProjectDetails(matchedId);
        if (projectDetails) {
          const cid = projectDetails.contact_id || projectDetails.contactId;
          if (cid) {
            const cname = await fetchContactName(cid);
            document.getElementById('contact-name').value = cname;
            document.getElementById('contact-id').value = cid;
          }
          const scid = projectDetails.sub_contact_id || projectDetails.contact_sub_id || projectDetails.contact_subId || projectDetails.contact_subid;
          if (scid) {
            const scname = await fetchContactName(scid);
            document.getElementById('sub-contact-name').value = scname;
            document.getElementById('sub-contact-id').value = scid;
          }
        }
      }
      // If this is a new entry, set default activity and status
      const isNewBlur = !document.getElementById('timesheet-id').value;
      if (isNewBlur) {
        const defAct = activities.find((a) => a.name && a.name.toLowerCase().includes('projekt durchf'));
        if (defAct) {
          document.getElementById('activity-select').value = defAct.id;
        }
        const defStat = statuses.find((s) => s.name && s.name.toLowerCase().includes('erledigt'));
        if (defStat) {
          document.getElementById('status-select').value = defStat.id;
        }
      }
    })();
  });

  // Close modals when pressing the Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // Close event modal if open
      const eventModal = document.getElementById('event-modal');
      if (eventModal && eventModal.style.display === 'flex') {
        closeModal();
      }
      // Close multi‑day modal if open
      const multiModal = document.getElementById('multi-modal');
      if (multiModal && multiModal.style.display === 'flex') {
        closeMultiModal();
      }
    }
  });
  // Modal buttons
  document.getElementById('cancel-btn').addEventListener('click', (e) => {
    e.preventDefault();
    closeModal();
  });
  document.getElementById('event-form').addEventListener('submit', saveTimesheet);
  document.getElementById('delete-btn').addEventListener('click', (e) => {
    e.preventDefault();
    deleteTimesheet();
  });

  // Close modal when pressing Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const modal = document.getElementById('event-modal');
      if (modal && modal.style.display === 'flex') {
        closeModal();
      }
    }
  });
}

// Main entry point: check authentication and initialise UI
document.addEventListener('DOMContentLoaded', async () => {
  const authenticated = await checkAuthStatus();
  if (!authenticated) {
    // Show login screen
    document.getElementById('login-screen').style.display = 'block';
    return;
  }
  // Show app and load data
  document.getElementById('app').style.display = 'block';
  // Enable dark mode by default.  This sets the ec-dark class on the body
  // so the calendar and other UI elements render with dark colours.
  document.body.classList.add('ec-dark');
  await loadReferenceData();
  bindUI();
  initCalendar();
});
