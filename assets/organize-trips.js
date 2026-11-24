/* The organiser page's away trips: an event's names and share card, its
 * facts and PPK's suggestions (FEAT-064 S6 and S7, #275, #276).
 *
 * A classic script, loaded after organize.js. It waits for that script's
 * "ppk-organizer" event, which carries the signed-in Supabase client once
 * the club grant is confirmed, so this file opens no second session.
 *
 * Every write goes through a function in 0020_events.sql, and the database
 * decides: a confirmed fact needs an https source link and the date it was
 * checked, and no phone number, email or member's detail is saved. The
 * checks here only say so sooner, in the form's own words. The list of
 * facts comes from the page (#trips-section's data-catalogue, written by
 * site_rides.py from site_events.FACT_CATALOGUE), so the names live in one
 * place.
 */
(function () {
  "use strict";

  var TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
  var ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  var LINK = /^https:\/\/[^\s"'<>]+$/;
  var PLAN_SOURCE = /^PPK trip plan, \d{1,2} [A-Z][a-z]{2} \d{4}$/;
  var MAPS_LINK = /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=[\w.~%+,-]+(&query_place_id=[\w-]+)?$/;
  var MAPS_SEARCH = "https://www.google.com/maps/search/?api=1&query=";
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // What the database's refusals mean, in the form's words. The code is the
  // error's hint (0020_events.sql).
  var REFUSALS = {
    fact_source: "Add a source link that starts with https://.",
    fact_checked: "Add the date you checked it.",
    fact_date: "The date isn't a real date.",
    fact_time: "A time is four digits, such as 06:45.",
    phone: "This looks like a phone number. No phone number is saved in a trip, except the organiser's and the hospital's public line.",
    email: "This looks like an email address. No email is saved in a trip, except the organiser's and the hospital's public address.",
    link_contact: "That link opens a chat, or carries a phone number or an email address.",
    personal_key: "That could hold a member's details, so it isn't saved.",
    link: "A link must start with https://.",
    contact_shape: "The phone number or the email isn't one.",
    one_line: "Keep each value on one line.",
    date_needed: "Confirm the event date first. A trip on the site keeps its date.",
    slug_taken: "That page address is taken.",
    slug_shape: "The page address is lowercase words and dashes, such as lakeside-classic-2027.",
    event_names: "The trip needs its event name, edition and short name.",
    pick_place: "Each suggestion needs its place.",
    pick_note: "Each suggestion needs a short note.",
    pick_count: "At most 20 suggestions.",
    pick_shape: "A suggestion has a kind, a place, a map link, a note and a meetup time only.",
    pick_kind: "A suggestion is a meal or sightseeing.",
    fact_key: "That fact has a part this page doesn't know, so it isn't saved.",
    fact_size: "That is too long to save as one fact.",
    event_published: "Take the trip off the site first: set it to Draft and save."
  };

  function refusalText(error) {
    if (!error) return "";
    return REFUSALS[error.hint] || String(error.message || "That couldn't be saved.");
  }

  function isRealDate(text) {
    if (!ISO_DATE.test(text)) return false;
    var date = new Date(text + "T00:00:00Z");
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
  }

  // "2027-03-12" as "12 Mar 2027".
  function dateText(iso) {
    return isRealDate(iso)
      ? Number(iso.slice(8)) + " " + MONTHS[Number(iso.slice(5, 7)) - 1] + " " + iso.slice(0, 4)
      : String(iso || "");
  }

  function lines(text) {
    return String(text || "").split(/\r?\n/).map(function (line) { return line.trim(); })
      .filter(Boolean);
  }

  // A fact's value as the form's text, by the kind of input the fact has.
  function valueToText(kind, value) {
    if (value === null || value === undefined) return "";
    if (["lines", "schedule", "closures", "distances"].indexOf(kind) !== -1 && !Array.isArray(value)) {
      return String(value);
    }
    if (kind === "lines") return value.join("\n");
    if (kind === "schedule") {
      return value.map(function (item) { return item.time + " " + item.what; }).join("\n");
    }
    if (kind === "closures") {
      return value.map(function (item) { return item.road + " | " + item.when; }).join("\n");
    }
    if (kind === "distances") {
      return value.map(function (item) {
        return [item.km, item.kind, item.start || "", item.cut_off || ""].join(" | ")
          .replace(/( \| )+$/, "");
      }).join("\n");
    }
    return String(value);
  }

  // The form's text as a fact's value, or {problem} when it can't be one.
  // previous is the saved value: a distance keeps its route file and route
  // links, which this form doesn't edit.
  function textToValue(kind, text, previous) {
    var rows = lines(text);
    if (kind === "lines") return rows.length ? { value: rows } : { problem: "Add at least one line." };
    if (kind === "schedule") {
      var steps = [];
      for (var i = 0; i < rows.length; i += 1) {
        var found = /^(\d{2}:\d{2})\s+(.+)$/.exec(rows[i]);
        if (!found || !TIME.test(found[1])) {
          return { problem: "Each line is a time and what happens, such as 06:30 Briefing." };
        }
        steps.push({ time: found[1], what: found[2].trim() });
      }
      if (!steps.length) return { problem: "Add at least one line." };
      for (var s = 1; s < steps.length; s += 1) {
        if (steps[s].time < steps[s - 1].time) return { problem: "Put the times in order." };
      }
      return { value: steps };
    }
    if (kind === "closures") {
      var closures = [];
      for (var c = 0; c < rows.length; c += 1) {
        var parts = rows[c].split("|").map(function (part) { return part.trim(); });
        if (parts.length !== 2 || !parts[0] || !parts[1]) {
          return { problem: "Each line is a road and when, such as Main Road | Sun 07:00 to 12:00." };
        }
        closures.push({ road: parts[0], when: parts[1] });
      }
      return closures.length ? { value: closures } : { problem: "Add at least one line." };
    }
    if (kind === "distances") {
      var distances = [];
      for (var d = 0; d < rows.length; d += 1) {
        var cells = rows[d].split("|").map(function (cell) { return cell.trim(); });
        var km = Number(cells[0]);
        if (cells.length < 2 || cells.length > 4 || !/^\d+$/.test(cells[0]) || km < 1 || km > 1000 || !cells[1]) {
          return { problem: "Each line is the distance in km and its kind, then the flag-off and the cut-off if known: 90 | race | 06:45 | 5 hours." };
        }
        var item = { km: km, kind: cells[1] };
        if (cells[2]) {
          if (!TIME.test(cells[2])) return { problem: "A flag-off is four digits, such as 06:45." };
          item.start = cells[2];
        }
        if (cells[3]) item.cut_off = cells[3];
        // The same distance as before, or the same line when no line was
        // added or removed, so a corrected km keeps its route file.
        var before = Array.isArray(previous) ? previous : [];
        var old = before.filter(function (one) { return one && one.km === km; })[0] ||
          (before.length === rows.length ? before[d] : null);
        if (old) {
          ["gpx", "gpx_from", "route_links"].forEach(function (key) {
            if (old[key] !== undefined) item[key] = old[key];
          });
        }
        distances.push(item);
      }
      return distances.length ? { value: distances } : { problem: "Add at least one line." };
    }
    var single = String(text || "").trim();
    if (!single) return { problem: "Add the value, or choose Not confirmed yet." };
    if (/[\r\n]/.test(single)) return { problem: "Keep it on one line." };
    if (kind === "date" && !isRealDate(single)) return { problem: "The date isn't a real date." };
    if (kind === "time" && !TIME.test(single)) return { problem: "A time is four digits, such as 06:45." };
    return { value: single };
  }

  // What is wrong with a confirmed fact before it is sent, or "". The
  // database and the build check again; this only answers sooner.
  function factProblem(entry, fact) {
    if (fact.value === null) return "";
    var sources = Array.isArray(fact.sources) ? fact.sources : [];
    if (!sources.length) return REFUSALS.fact_source;
    for (var i = 0; i < sources.length; i += 1) {
      if (!LINK.test(sources[i]) && !(entry.group === "plan" && PLAN_SOURCE.test(sources[i]))) {
        return entry.group === "plan"
          ? "A source is an https link, or PPK's own plan: PPK trip plan, 2 Mar 2027."
          : REFUSALS.fact_source;
      }
    }
    if (!isRealDate(String(fact.checked || ""))) return REFUSALS.fact_checked;
    if (fact.link !== undefined && !LINK.test(fact.link)) return REFUSALS.link;
    if (fact.map_link !== undefined && !MAPS_LINK.test(fact.map_link)) {
      return "A Google Maps link starts https://www.google.com/maps/search/?api=1&query=";
    }
    if (fact.day !== undefined && !isRealDate(fact.day)) return "The day isn't a real date.";
    if (fact.closes !== undefined && !TIME.test(fact.closes)) return REFUSALS.fact_time;
    return "";
  }

  // One line for the list: the value as text, short.
  function summary(kind, value) {
    if (value === null || value === undefined) return "To be confirmed";
    var text;
    if (kind === "distances" && Array.isArray(value)) {
      text = value.map(function (item) { return item.km + " km " + item.kind; }).join(" · ");
    } else if (kind === "date") {
      text = dateText(value);
    } else if (Array.isArray(value)) {
      text = value.length + (value.length === 1 ? " line" : " lines");
    } else {
      text = String(value);
    }
    return text.length > 90 ? text.slice(0, 87) + "..." : text;
  }

  // A Google Maps search for a place, every character a link may not hold
  // encoded: encodeURIComponent leaves ! ' ( ) * as they are.
  function mapsSearch(place) {
    return MAPS_SEARCH + encodeURIComponent(place).replace(/[!'()*]/g, function (char) {
      return "%" + char.charCodeAt(0).toString(16).toUpperCase();
    });
  }

  // A trip file's contents (trips/<slug>.json) as the calls that save it
  // here: the event, each fact, and PPK's suggestions as picks. A pick's
  // Map button opens a Google Maps search for its place, as the page built
  // from the file does.
  function tripFileParts(doc, catalogue) {
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { problem: "That file isn't a trip file." };
    var event = {};
    var names = ["slug", "event_name", "edition", "trip_label"];
    for (var i = 0; i < names.length; i += 1) {
      if (typeof doc[names[i]] !== "string" || !doc[names[i]].trim()) {
        return { problem: "That file isn't a trip file: it has no " + names[i] + "." };
      }
      event[names[i]] = doc[names[i]].trim();
    }
    event.card = doc.card === "route" ? "route" : "standard";
    var facts = [];
    var skipped = [];
    catalogue.forEach(function (entry) {
      var fact = (doc[entry.group] || {})[entry.name];
      if (!fact || typeof fact !== "object" || fact.value === null || fact.value === undefined) return;
      // The same checks as the form: a value the form couldn't show is left out, and named.
      var again = textToValue(entry.kind, valueToText(entry.kind, fact.value), fact.value);
      var problem = again.problem || factProblem(entry, fact);
      if (problem) {
        skipped.push(entry.label + " (" + problem + ")");
      } else {
        facts.push({ group: entry.group, name: entry.name, fact: fact });
      }
    });
    var kinds = { dinner: "meal", makan: "meal", see: "sightseeing" };
    var picks = (Array.isArray(doc.suggestions) ? doc.suggestions : []).map(function (item) {
      return { kind: kinds[item.kind] || "meal", place: String(item.title || ""),
               map_link: mapsSearch(String(item.place || item.title || "")),
               note: String(item.note || "") };
    }).concat((Array.isArray(doc.recommendations) ? doc.recommendations : []));
    return { event: event, facts: facts, picks: picks, skipped: skipped };
  }

  var api = {
    refusalText: refusalText, isRealDate: isRealDate, dateText: dateText,
    valueToText: valueToText, textToValue: textToValue, factProblem: factProblem,
    summary: summary, tripFileParts: tripFileParts, mapsSearch: mapsSearch, REFUSALS: REFUSALS
  };
  // Under Node, for the tests: the functions above and nothing else.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
    return;
  }

  var rootEl = document.getElementById("organize-root");
  var sectionEl = document.getElementById("trips-section");
  if (!rootEl || !sectionEl) return;
  var catalogue = JSON.parse(sectionEl.getAttribute("data-catalogue"));

  var listEl = document.getElementById("trip-list");
  var listEmptyEl = document.getElementById("trip-list-empty");
  var newButton = document.getElementById("trip-new");
  var importInput = document.getElementById("trip-import");
  var formEl = document.getElementById("trip-form");
  var formTitleEl = document.getElementById("trip-form-title");
  var slugInput = document.getElementById("trip-slug");
  var statusFieldEl = document.getElementById("trip-status-field");
  var statusInput = document.getElementById("trip-status");
  var cardInput = document.getElementById("trip-card");
  var saveButton = document.getElementById("trip-save");
  var formCancelButton = document.getElementById("trip-form-cancel");
  var deleteButton = document.getElementById("trip-delete");
  var formErrorEl = document.getElementById("trip-form-error");
  var editorEl = document.getElementById("trip-editor");
  var factsEl = document.getElementById("trip-facts");
  var planEl = document.getElementById("trip-plan");
  var picksEl = document.getElementById("trip-picks");
  var pickAddButton = document.getElementById("trip-pick-add");
  var picksSaveButton = document.getElementById("trip-picks-save");
  var picksErrorEl = document.getElementById("trip-picks-error");
  var statusEl = document.getElementById("trip-status-line");

  var client = null;
  var editing = null;      // the trip the form is editing, or null for a new one
  var facts = {};          // "facts.date" -> the saved fact
  var listVersion = 0;     // bumped on every trips reload, drops stale replies
  var factsVersion = 0;    // bumped when a trip opens or closes, drops stale replies

  function el(tag, text, className) {
    var node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function button(label, onClick) {
    var node = el("button", label, "btn");
    node.type = "button";
    node.addEventListener("click", onClick);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function showError(node, message) {
    node.setAttribute("role", "alert");
    node.textContent = message;
    node.hidden = !message;
  }

  // A request that never came back (the network, not a refusal).
  function requestFailed() {
    return { error: { message: "Couldn't reach the server. Check your connection and try again." } };
  }

  function field(id, label, input) {
    var wrap = el("div");
    var labelEl = el("label", label);
    labelEl.htmlFor = id;
    input.id = id;
    wrap.appendChild(labelEl);
    wrap.appendChild(input);
    return wrap;
  }

  function textInput(type, value, maxLength) {
    var input = document.createElement("input");
    input.type = type;
    input.value = value || "";
    if (maxLength) input.maxLength = maxLength;
    return input;
  }

  // Today in Malaysia, for the "date you checked it" default.
  function today() {
    return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  // ---------------------------------------------------------------- trips

  function loadTrips() {
    var version = (listVersion += 1);
    client.from("events")
      .select("id, slug, kind, event_name, edition, trip_label, card, status")
      .eq("kind", "away_trip").order("slug")
      .then(function (res) {
        if (version !== listVersion) return;
        clear(listEl);
        if (res.error && res.error.code === "PGRST205") {
          // This project has no events table yet (0020 not promoted): the
          // section stays out of the way until it has.
          sectionEl.hidden = true;
          return;
        }
        if (res.error) {
          statusEl.textContent = "Couldn't load the trips: " + res.error.message;
          return;
        }
        listEmptyEl.hidden = res.data.length > 0;
        res.data.forEach(function (trip) {
          var row = el("li");
          row.appendChild(el("b", trip.edition));
          row.appendChild(el("span", " · " + (trip.status === "published" ? "on the site" : "draft")));
          var edit = button("Edit", function () { openTrip(trip); });
          edit.setAttribute("aria-label", "Edit " + trip.edition);
          row.appendChild(edit);
          listEl.appendChild(row);
        });
      });
  }

  function closeTrip() {
    factsVersion += 1;
    editing = null;
    facts = {};
    formEl.hidden = true;
    editorEl.hidden = true;
    showError(formErrorEl, "");
    showError(picksErrorEl, "");
  }

  function openTrip(trip) {
    closeTrip();
    editing = trip;
    formEl.hidden = false;
    formTitleEl.textContent = trip ? "Edit trip" : "New trip";
    slugInput.value = trip ? trip.slug : "";
    slugInput.disabled = !!trip;
    ["event_name", "edition", "trip_label"].forEach(function (name) {
      document.getElementById("trip-" + name).value = trip ? trip[name] : "";
    });
    cardInput.value = trip ? trip.card : "standard";
    statusInput.value = trip ? trip.status : "draft";
    // A new trip starts as a draft: it can go on the site once its date is confirmed.
    statusFieldEl.hidden = !trip;
    // Only a draft can be deleted, so a page on the site never goes in one step.
    deleteButton.hidden = !trip || trip.status !== "draft";
    if (trip) loadFacts(trip);
    formEl.scrollIntoView();
  }

  function eventPayload() {
    return {
      p_event_name: document.getElementById("trip-event_name").value,
      p_edition: document.getElementById("trip-edition").value,
      p_trip_label: document.getElementById("trip-trip_label").value,
      p_card: cardInput.value,
      p_status: statusInput.value
    };
  }

  function saveEvent(id) {
    var payload = eventPayload();
    payload.p_event_id = id;
    return client.rpc("update_event", payload);
  }

  formEl.addEventListener("submit", function (event) {
    event.preventDefault();
    showError(formErrorEl, "");
    saveButton.disabled = true;
    var was = editing;
    var payload = eventPayload();
    // trip is what was saved, or null when nothing was. The form reopens on
    // it only if the organiser hasn't moved to another trip meanwhile.
    var done = function (res, trip) {
      saveButton.disabled = false;
      if (!client) return;
      if (trip) {
        loadTrips();
        if (editing === was) openTrip(trip);
      }
      if (res.error) {
        showError(formErrorEl, refusalText(res.error));
        return;
      }
      statusEl.textContent = "Trip saved.";
    };
    if (was) {
      saveEvent(was.id).then(function (res) {
        done(res, res.error ? null : {
          id: was.id, slug: was.slug, kind: was.kind, event_name: payload.p_event_name.trim(),
          edition: payload.p_edition.trim(), trip_label: payload.p_trip_label.trim(),
          card: payload.p_card, status: payload.p_status
        });
      }, function () { done(requestFailed(), null); });
      return;
    }
    var slug = slugInput.value.trim();
    client.rpc("create_event", {
      p_slug: slug, p_event_name: payload.p_event_name, p_edition: payload.p_edition,
      p_trip_label: payload.p_trip_label
    }).then(function (res) {
      if (res.error) {
        done(res, null);
        return;
      }
      // The trip exists from here on, so the form turns into an edit of it
      // even if saving its card fails: a second Save must not create it again.
      var trip = { id: res.data, slug: slug, kind: "away_trip", event_name: payload.p_event_name.trim(),
                   edition: payload.p_edition.trim(), trip_label: payload.p_trip_label.trim(),
                   card: "standard", status: "draft" };
      // The card choice is saved with the new trip; a draft needs no date.
      statusInput.value = "draft";
      saveEvent(trip.id).then(function (cardRes) {
        if (!cardRes.error) trip.card = payload.p_card;
        done(cardRes, trip);
      }, function () { done(requestFailed(), trip); });
    }, function () { done(requestFailed(), null); });
  });

  // ---------------------------------------------------------------- facts

  function loadFacts(trip) {
    var version = (factsVersion += 1);
    Promise.all([
      client.from("event_facts").select("grp, name, fact").eq("event_id", trip.id),
      client.from("event_recommendations")
        .select("position, kind, place, map_link, note, meetup_time")
        .eq("event_id", trip.id).order("position")
    ]).then(function (replies) {
      if (version !== factsVersion || editing !== trip) return;
      if (replies[0].error || replies[1].error) {
        showError(formErrorEl, "Couldn't load this trip's facts: " +
          (replies[0].error || replies[1].error).message);
        return;
      }
      facts = {};
      replies[0].data.forEach(function (row) { facts[row.grp + "." + row.name] = row.fact; });
      drawFacts();
      clear(picksEl);
      replies[1].data.forEach(addPickRow);
      editorEl.hidden = false;
    }).catch(function () {
      if (version !== factsVersion || editing !== trip) return;
      showError(formErrorEl, "Couldn't load this trip's facts. Close the form and open it again.");
    });
  }

  function drawFacts() {
    clear(factsEl);
    clear(planEl);
    catalogue.facts.forEach(function (entry) {
      (entry.group === "facts" ? factsEl : planEl).appendChild(factRow(entry));
    });
  }

  function factRow(entry) {
    var fact = facts[entry.group + "." + entry.name] || { value: null };
    var row = el("li");
    row.appendChild(el("b", entry.label));
    row.appendChild(el("span", " " + summary(entry.kind, fact.value)));
    if (fact.value !== null && fact.value !== undefined) {
      var count = (fact.sources || []).length;
      row.appendChild(el("small", "Checked " + dateText(fact.checked) + " · " + count +
                                  (count === 1 ? " source" : " sources"), "note"));
    }
    var edit = button("Edit", function () {
      row.parentNode.replaceChild(factEditor(entry, fact), row);
    });
    edit.setAttribute("aria-label", "Edit " + entry.label);
    row.appendChild(edit);
    return row;
  }

  function valueInput(entry, fact) {
    var text = valueToText(entry.kind, fact.value);
    if (entry.kind === "choice") {
      var select = document.createElement("select");
      entry.options.concat(text && entry.options.indexOf(text) === -1 ? [text] : [])
        .forEach(function (option) {
          var item = el("option", option);
          item.value = option;
          select.appendChild(item);
        });
      if (text) select.value = text;
      return select;
    }
    if (["lines", "schedule", "closures", "distances"].indexOf(entry.kind) !== -1) {
      var area = document.createElement("textarea");
      area.rows = 4;
      area.value = text;
      return area;
    }
    return textInput(entry.kind === "date" ? "date" : entry.kind === "time" ? "time" : "text", text, 500);
  }

  var VALUE_HELP = {
    lines: "One per line.",
    schedule: "One per line: the time, then what happens. 06:30 Briefing at the arch",
    closures: "One per line: the road, then when. Main Road | Sun 07:00 to 12:00",
    distances: "One per line: km | kind | flag-off | cut-off. 90 | race | 06:45 | 5 hours"
  };

  function factEditor(entry, fact) {
    var key = "fact-" + entry.group + "-" + entry.name;
    var row = el("li", "", "fact-editor");
    row.appendChild(el("b", entry.label));
    var value = valueInput(entry, fact);
    row.appendChild(field(key, entry.label, value));
    if (VALUE_HELP[entry.kind]) row.appendChild(el("p", VALUE_HELP[entry.kind], "note"));
    var extras = {};
    entry.extras.forEach(function (name) {
      var type = name === "day" ? "date" : name === "closes" ? "time" : "text";
      extras[name] = textInput(type, fact[name], 500);
      row.appendChild(field(key + "-" + name, catalogue.extras[name] + " (optional)", extras[name]));
    });
    var sources = document.createElement("textarea");
    sources.rows = 2;
    sources.value = (fact.sources || []).join("\n");
    row.appendChild(field(key + "-sources", "Source links, one per line", sources));
    if (entry.group === "plan") {
      row.appendChild(el("p", "For a fact PPK sets itself, write: PPK trip plan, 2 Mar 2027", "note"));
    }
    var checked = textInput("date", fact.checked || today());
    row.appendChild(field(key + "-checked", "Date you checked it", checked));
    var errorEl = el("p", "", "account-error");
    errorEl.hidden = true;

    function send(next) {
      showError(errorEl, "");
      var problem = factProblem(entry, next);
      if (problem) {
        showError(errorEl, problem);
        return;
      }
      var trip = editing;
      client.rpc("set_event_fact", {
        p_event_id: trip.id, p_group: entry.group, p_name: entry.name, p_fact: next
      }).then(function (res) {
        // The organiser has moved on: this reply is for a trip no longer on screen.
        if (editing !== trip) return;
        if (res.error) {
          showError(errorEl, refusalText(res.error));
          return;
        }
        facts[entry.group + "." + entry.name] = next;
        statusEl.textContent = entry.label + " saved. It shows on the trip page now; " +
          "the WhatsApp preview changes at the next publish.";
        if (row.parentNode) row.parentNode.replaceChild(factRow(entry), row);
      }, function () {
        if (editing === trip) showError(errorEl, requestFailed().error.message);
      });
    }

    row.appendChild(button("Save fact", function () {
      var parsed = textToValue(entry.kind, value.value, fact.value);
      if (parsed.problem) {
        showError(errorEl, parsed.problem);
        return;
      }
      // Keys this form doesn't show stay as they were saved.
      var next = {};
      Object.keys(fact).forEach(function (name) { next[name] = fact[name]; });
      next.value = parsed.value;
      next.sources = lines(sources.value);
      next.checked = checked.value;
      entry.extras.forEach(function (name) {
        var text = extras[name].value.trim();
        if (text) next[name] = text; else delete next[name];
      });
      send(next);
    }));
    row.appendChild(button("Not confirmed yet", function () { send({ value: null }); }));
    row.appendChild(button("Cancel", function () {
      row.parentNode.replaceChild(factRow(entry), row);
    }));
    row.appendChild(errorEl);
    return row;
  }

  // ---------------------------------------------------------------- suggestions

  var pickCount = 0;

  function addPickRow(pick) {
    pickCount += 1;
    var key = "pick-" + pickCount;
    var row = el("li", "", "pick-row");
    var kind = document.createElement("select");
    catalogue.kinds.forEach(function (item) {
      var option = el("option", item[1]);
      option.value = item[0];
      kind.appendChild(option);
    });
    kind.value = (pick && pick.kind) || catalogue.kinds[0][0];
    var inputs = {
      kind: kind,
      place: textInput("text", pick && pick.place, 120),
      map_link: textInput("url", pick && pick.map_link, 500),
      note: textInput("text", pick && pick.note, 200),
      meetup_time: textInput("time", pick && pick.meetup_time)
    };
    row.appendChild(field(key + "-kind", "Kind", inputs.kind));
    row.appendChild(field(key + "-place", "Place", inputs.place));
    row.appendChild(field(key + "-map", "Map link (https)", inputs.map_link));
    row.appendChild(field(key + "-note", "Short note", inputs.note));
    row.appendChild(field(key + "-time", "Meetup time (optional)", inputs.meetup_time));
    var remove = button("Remove", function () { picksEl.removeChild(row); });
    remove.setAttribute("aria-label", "Remove this suggestion");
    row.appendChild(remove);
    row.pickInputs = inputs;
    picksEl.appendChild(row);
  }

  pickAddButton.addEventListener("click", function () {
    if (picksEl.children.length >= 20) {
      showError(picksErrorEl, REFUSALS.pick_count);
      return;
    }
    addPickRow(null);
  });

  picksSaveButton.addEventListener("click", function () {
    showError(picksErrorEl, "");
    var items = [];
    for (var i = 0; i < picksEl.children.length; i += 1) {
      var inputs = picksEl.children[i].pickInputs;
      var item = { kind: inputs.kind.value, place: inputs.place.value.trim(),
                   map_link: inputs.map_link.value.trim(), note: inputs.note.value.trim() };
      if (inputs.meetup_time.value) item.meetup_time = inputs.meetup_time.value;
      if (!item.place) return showError(picksErrorEl, REFUSALS.pick_place);
      if (!LINK.test(item.map_link)) return showError(picksErrorEl, "The map link must start with https://.");
      if (!item.note) return showError(picksErrorEl, REFUSALS.pick_note);
      items.push(item);
    }
    var trip = editing;
    client.rpc("set_event_recommendations", { p_event_id: trip.id, p_items: items })
      .then(function (res) {
        if (editing !== trip) return;
        if (res.error) {
          showError(picksErrorEl, refusalText(res.error));
          return;
        }
        statusEl.textContent = "Suggestions saved. They show on the trip page now.";
      }, function () {
        if (editing === trip) showError(picksErrorEl, requestFailed().error.message);
      });
  });

  // ---------------------------------------------------------------- a trip file

  // Saves a trip file's event, facts and suggestions through the same
  // functions the form uses, so the same refusals apply. The file is read
  // here and never uploaded.
  importInput.addEventListener("change", function () {
    var file = importInput.files && importInput.files[0];
    importInput.value = "";
    if (!file) return;
    statusEl.textContent = "Reading the file...";
    file.text().then(function (text) {
      var parts;
      try {
        parts = tripFileParts(JSON.parse(text.replace(/^\uFEFF/, "")), catalogue.facts);
      } catch (error) {
        parts = { problem: "That file isn't a trip file." };
      }
      if (parts.problem || !client) {
        statusEl.textContent = parts.problem || "";
        return;
      }
      client.rpc("create_event", {
        p_slug: parts.event.slug, p_event_name: parts.event.event_name,
        p_edition: parts.event.edition, p_trip_label: parts.event.trip_label
      }).then(function (res) {
        if (res.error) {
          statusEl.textContent = "Not brought in: " + refusalText(res.error);
          return;
        }
        var id = res.data;
        var failed = parts.skipped.slice();
        var chain = Promise.resolve();
        parts.facts.forEach(function (item) {
          chain = chain.then(function () {
            return client.rpc("set_event_fact", {
              p_event_id: id, p_group: item.group, p_name: item.name, p_fact: item.fact
            }).then(function (factRes) {
              if (factRes.error) failed.push(item.name + " (" + refusalText(factRes.error) + ")");
            });
          });
        });
        chain.then(function () {
          return client.rpc("set_event_recommendations", { p_event_id: id, p_items: parts.picks });
        }).then(function (pickRes) {
          if (pickRes.error) failed.push("suggestions (" + refusalText(pickRes.error) + ")");
          return client.rpc("update_event", {
            p_event_id: id, p_event_name: parts.event.event_name, p_edition: parts.event.edition,
            p_trip_label: parts.event.trip_label, p_card: parts.event.card, p_status: "draft"
          });
        }).then(function () {
          statusEl.textContent = failed.length
            ? "Brought in as a draft, but not: " + failed.join("; ") + "."
            : "Brought in as a draft, with " + parts.facts.length + " facts. Check it, then put it on the site.";
          if (client) loadTrips();
        }).catch(function () {
          statusEl.textContent = "The connection dropped part-way. The draft is in the list: open it and check what was saved.";
          if (client) loadTrips();
        });
      }, function () {
        statusEl.textContent = "Not brought in: " + requestFailed().error.message;
      });
    });
  });

  // ---------------------------------------------------------------- wiring

  deleteButton.addEventListener("click", function () {
    if (!editing || !window.confirm("Delete the draft " + editing.edition + ", with its facts and suggestions?")) return;
    showError(formErrorEl, "");
    var trip = editing;
    client.rpc("delete_event", { p_event_id: trip.id }).then(function (res) {
      if (!client) return;
      if (res.error) {
        if (editing === trip) showError(formErrorEl, refusalText(res.error));
        return;
      }
      if (editing === trip) closeTrip();
      statusEl.textContent = "Draft deleted.";
      loadTrips();
    }, function () {
      if (editing === trip) showError(formErrorEl, requestFailed().error.message);
    });
  });
  newButton.addEventListener("click", function () { openTrip(null); });
  formCancelButton.addEventListener("click", closeTrip);

  rootEl.addEventListener("ppk-organizer", function (event) {
    client = event.detail.client;
    sectionEl.hidden = false;
    loadTrips();
  });
  rootEl.addEventListener("ppk-organizer-out", function () {
    // Leaves nothing of the organiser's session on screen.
    listVersion += 1;
    client = null;
    closeTrip();
    formEl.reset();
    clear(listEl);
    clear(factsEl);
    clear(planEl);
    clear(picksEl);
    statusEl.textContent = "";
    sectionEl.hidden = true;
  });
})();
