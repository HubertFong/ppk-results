/* The PPK ride organizer page: create and edit rides, change their status,
 * see who signed up and mark attendance.
 *
 * A classic script, loaded at the end of the body by site_rides.py, so every
 * element below already exists when it runs. Its only dependency is the
 * global `supabase` from the pinned supabase-js tag on the same page.
 * Config comes from #organize-root's data attributes, never from inline text.
 */
(function () {
  "use strict";

  // Exactly the columns 0006_rides.sql and 0016 grant. select("*") is
  // refused, because created_by is not readable.
  var RIDE_SELECT =
    "id, title, meeting_point, meeting_map_link, meet_at, depart_at, " +
    "route_link, distance_m, climbing_m, regroup_policy, pace_note, " +
    "capacity, signup_deadline, status, signup_type, required_fields";

  // Who can sign up (#110), as the ride list says it, and the details a
  // type 3 ride may ask for, as 0016 allows them.
  var SIGNUP_TYPE_TEXT = {
    name: "anyone, by typing a name",
    account: "PPK members",
    fields: "PPK members with chosen details"
  };
  var DETAIL_FIELDS = [
    { name: "bike_type", label: "Bike type" },
    { name: "gender", label: "Gender" }
  ];

  // The ride form's fields, in the order the form shows them: each input is
  // #ride-<column> and each create_ride()/update_ride() argument is <param>.
  // Distance is the one conversion: the form asks in kilometres, the table
  // stores metres.
  var RIDE_FIELDS = [
    { column: "title", param: "p_title", kind: "text" },
    { column: "meeting_point", param: "p_meeting_point", kind: "text" },
    { column: "meeting_map_link", param: "p_meeting_map_link", kind: "text" },
    { column: "meet_at", param: "p_meet_at", kind: "datetime" },
    { column: "depart_at", param: "p_depart_at", kind: "datetime" },
    { column: "signup_deadline", param: "p_signup_deadline", kind: "datetime" },
    { column: "signup_type", param: "p_signup_type", kind: "text" },
    { column: "capacity", param: "p_capacity", kind: "integer" },
    { column: "route_link", param: "p_route_link", kind: "text" },
    { column: "distance_km", param: "p_distance_m", kind: "km" },
    { column: "climbing_m", param: "p_climbing_m", kind: "integer" },
    { column: "regroup_policy", param: "p_regroup_policy", kind: "text" },
    { column: "pace_note", param: "p_pace_note", kind: "text" }
  ];

  var rootEl = document.getElementById("organize-root");
  var loadingEl = document.getElementById("organize-loading");
  var signedOutEl = document.getElementById("organize-signed-out");
  var signInLink = document.getElementById("organize-signin");
  var deniedEl = document.getElementById("organize-denied");
  var appEl = document.getElementById("organize-app");
  var newButton = document.getElementById("ride-new");
  var formEl = document.getElementById("ride-form");
  var formTitleEl = document.getElementById("ride-form-title");
  var meetAtInput = document.getElementById("ride-meet_at");
  var departAtInput = document.getElementById("ride-depart_at");
  var deadlineInput = document.getElementById("ride-signup_deadline");
  var signupTypeInput = document.getElementById("ride-signup_type");
  var detailsFieldset = document.getElementById("ride-fields-fieldset");
  var saveButton = document.getElementById("ride-save");
  var formCancelButton = document.getElementById("ride-form-cancel");
  var formErrorEl = document.getElementById("ride-form-error");
  var gpxInput = document.getElementById("ride-gpx");
  var gpxStatusEl = document.getElementById("ride-gpx-status");
  var startsEl = document.getElementById("ride-starts");
  var startAddButton = document.getElementById("ride-start-add");
  var listEl = document.getElementById("ride-list");
  var listEmptyEl = document.getElementById("ride-list-empty");
  var rosterEl = document.getElementById("roster");
  var rosterTitleEl = document.getElementById("roster-title");
  var rosterNoteEl = document.getElementById("roster-note");
  var rosterListEl = document.getElementById("roster-list");
  var rosterEmptyEl = document.getElementById("roster-empty");
  var rosterCloseButton = document.getElementById("roster-close");
  var rosterDownloadButton = document.getElementById("roster-download");
  var statusEl = document.getElementById("organize-status");
  var errorEl = document.getElementById("organize-error");

  var client = supabase.createClient(rootEl.dataset.supabaseUrl, rootEl.dataset.supabaseKey);

  var startedUserId = null;   // whose access check has already run
  var listVersion = 0;        // bumped on every rides reload, drops stale replies
  var formVersion = 0;        // bumped on every form open, copy or close, drops stale replies
  // False while a saved ride's extra points are loading into the form, or
  // after they failed to load. Saving then would send an empty list, and
  // set_ride_starts() would delete the points the form never showed.
  var startsReady = true;
  var editingRide = null;     // the ride the form is editing, or null for a new one
  var deadlineEdited = false; // the deadline was typed by hand in this form
  var rosterRide = null;      // the ride whose roster is on screen, or null
  var rosterVersion = 0;      // bumped on every roster load, drops stale replies
  var rosterData = null;      // the roster on screen, for its download; null while loading

  function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  // Nodes are built from data with textContent and properties, never markup.
  function textBlock(tag, text, className) {
    var el = document.createElement(tag);
    el.textContent = text;
    if (className) el.className = className;
    return el;
  }

  function actionButton(label, onClick) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "btn";
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  function clearOrganizeError() {
    errorEl.textContent = "";
    errorEl.hidden = true;
  }

  function showOrganizeError(message) {
    errorEl.textContent = "Something went wrong: " + message;
    errorEl.hidden = false;
  }

  function clearFormError() {
    formErrorEl.textContent = "";
    formErrorEl.hidden = true;
  }

  function showFormError(message) {
    formErrorEl.textContent = message;
    formErrorEl.hidden = false;
  }

  function inputFor(column) {
    return document.getElementById("ride-" + column);
  }

  // <input type="datetime-local"> speaks the browser's local wall time, so
  // the form is filled from local getters and the payload is sent as UTC.
  function localDateTimeText(date) {
    var month = String(date.getMonth() + 1).padStart(2, "0");
    var day = String(date.getDate()).padStart(2, "0");
    var hour = String(date.getHours()).padStart(2, "0");
    var minute = String(date.getMinutes()).padStart(2, "0");
    return date.getFullYear() + "-" + month + "-" + day + "T" + hour + ":" + minute;
  }

  function localDateTimeValue(value) {
    var date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : localDateTimeText(date);
  }

  // Sign-up closes 30 minutes before the meet-up by default (Hubert,
  // 2026-09-29; it was 8pm the evening before, #33).
  var DEADLINE_LEAD_MINUTES = 30;

  function defaultDeadline(meetAtValue) {
    var meet = new Date(meetAtValue);
    if (Number.isNaN(meet.getTime())) return "";
    return localDateTimeText(new Date(meet.getTime() - DEADLINE_LEAD_MINUTES * 60 * 1000));
  }

  // ------------------------------------------------------- sign in / access

  // Leaves nothing of the organizer's session on screen.
  function showSignedOut() {
    startedUserId = null;
    closeRoster();
    closeForm();
    listVersion += 1;
    clearChildren(listEl);
    listEmptyEl.hidden = true;
    loadingEl.hidden = true;
    deniedEl.hidden = true;
    appEl.hidden = true;
    signedOutEl.hidden = false;
    statusEl.textContent = "";
    clearOrganizeError();
    signInLink.href = "account.html?returnTo=" +
      encodeURIComponent(location.pathname + location.search);
  }

  function checkAccess() {
    clearOrganizeError();
    loadingEl.hidden = false;
    signedOutEl.hidden = true;
    deniedEl.hidden = true;
    appEl.hidden = true;
    client.rpc("has_club_role", { required_role: "event_organizer" }).then(function (res) {
      loadingEl.hidden = true;
      if (res.error) {
        showOrganizeError(res.error.message);
        return;
      }
      if (res.data !== true) {
        deniedEl.hidden = false;
        return;
      }
      appEl.hidden = false;
      loadRides();
    });
  }

  function applySession(session) {
    if (!session) {
      showSignedOut();
      return;
    }
    // getSession() and INITIAL_SESSION report the same session, so only the
    // first one for this user runs the access check.
    if (session.user.id === startedUserId) return;
    startedUserId = session.user.id;
    checkAccess();
  }

  // ------------------------------------------------------------ rides list

  function formatMeetAt(value) {
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value === null || value === undefined ? "" : String(value);
    }
    return date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
  }

  function rideHasStarted(ride) {
    return new Date(ride.depart_at).getTime() <= Date.now();
  }

  function changeStatus(ride, status) {
    clearOrganizeError();
    client.rpc("set_ride_status", { p_ride_id: ride.id, p_status: status }).then(function (res) {
      if (res.error) {
        showOrganizeError(res.error.message);
        return;
      }
      loadRides();
    });
  }

  // The buttons one ride's row carries. Cancelled is final, so it offers no
  // status move and no editing.
  function rideButtons(ride) {
    var buttons = document.createDocumentFragment();
    if (ride.status !== "cancelled") {
      buttons.appendChild(actionButton("Edit", function () { openForm(ride); }));
    }
    if (ride.status === "draft" || ride.status === "postponed") {
      buttons.appendChild(actionButton("Publish", function () { changeStatus(ride, "published"); }));
    }
    if (ride.status === "published") {
      buttons.appendChild(actionButton("Postpone", function () { changeStatus(ride, "postponed"); }));
    }
    if (ride.status !== "cancelled") {
      buttons.appendChild(actionButton("Cancel ride", function () {
        if (window.confirm("Cancel this ride? This can't be undone.")) {
          changeStatus(ride, "cancelled");
        }
      }));
    }
    buttons.appendChild(actionButton("Copy", function () { copyRide(ride); }));
    buttons.appendChild(actionButton("Roster", function () { openRoster(ride); }));
    return buttons;
  }

  function rideItem(ride, version) {
    var item = document.createElement("li");
    var heading = document.createElement("div");
    heading.appendChild(textBlock("strong", ride.title));
    heading.appendChild(textBlock("span", " [" + ride.status + "]"));
    item.appendChild(heading);
    item.appendChild(textBlock("div", "Meets " + formatMeetAt(ride.meet_at)));
    item.appendChild(textBlock("div", "Who can sign up: " +
      (SIGNUP_TYPE_TEXT[ride.signup_type] || ride.signup_type)));
    var places = textBlock("div", "Checking places taken...");
    item.appendChild(places);
    client.rpc("ride_places_taken", { ride_id: ride.id }).then(function (res) {
      // A reply for a ride that has been reloaded away is dropped.
      if (version !== listVersion || !listEl.contains(item)) return;
      if (res.error) {
        places.textContent = "";
        showOrganizeError(res.error.message);
        return;
      }
      var taken = res.data || 0;
      places.textContent = ride.capacity === null
        ? taken + " signed up (no limit)"
        : taken + " of " + ride.capacity + " places taken";
    });
    item.appendChild(rideButtons(ride));
    return item;
  }

  function loadRides() {
    clearOrganizeError();
    listVersion += 1;
    var version = listVersion;
    clearChildren(listEl);
    listEmptyEl.hidden = true;
    client.from("sessions")
      .select(RIDE_SELECT)
      .order("meet_at", { ascending: false })
      .then(function (res) {
        if (version !== listVersion) return;
        if (res.error) {
          showOrganizeError(res.error.message);
          return;
        }
        var rides = res.data || [];
        rides.forEach(function (ride) {
          listEl.appendChild(rideItem(ride, version));
        });
        listEmptyEl.hidden = rides.length > 0;
      });
  }

  // ------------------------------------------------------------- ride form

  function fillRideForm(ride) {
    RIDE_FIELDS.forEach(function (field) {
      var input = inputFor(field.column);
      if (field.kind === "km") {
        var metres = ride ? ride.distance_m : null;
        input.value = (metres === null || metres === undefined) ? "" : (metres / 1000).toFixed(1);
        return;
      }
      var value = ride ? ride[field.column] : null;
      if (value === null || value === undefined) {
        input.value = "";
      } else if (field.kind === "datetime") {
        input.value = localDateTimeValue(value);
      } else {
        input.value = String(value);
      }
    });
    // A new ride starts as type 1, the ordinary ride (Hubert, 2026-09-30).
    if (signupTypeInput.value === "") signupTypeInput.value = "name";
    var required = (ride && ride.required_fields) || [];
    DETAIL_FIELDS.forEach(function (detail) {
      detailBox(detail.name).checked = required.indexOf(detail.name) !== -1;
    });
    showDetails();
  }

  function detailBox(column) {
    return document.getElementById("ride-required-" + column);
  }

  function checkedDetails() {
    return DETAIL_FIELDS.map(function (detail) { return detail.name; })
      .filter(function (column) { return detailBox(column).checked; });
  }

  // The details are for a type 3 ride only.
  function showDetails() {
    detailsFieldset.hidden = signupTypeInput.value !== "fields";
  }

  signupTypeInput.addEventListener("change", showDetails);

  function openForm(ride) {
    // Every opening is a new form version, so a late reply for an earlier
    // form can never add its rows to this one.
    formVersion += 1;
    var version = formVersion;
    editingRide = ride || null;
    // A saved ride's deadline was chosen already: moving its meet-up must not
    // quietly reset it. Only a new ride gets the 30-minute default.
    deadlineEdited = Boolean(editingRide);
    formEl.reset();
    fillRideForm(editingRide);
    formTitleEl.textContent = editingRide ? "Edit ride" : "New ride";
    clearFormError();
    showGpxStatus("");
    formEl.hidden = false;
    inputFor("title").focus();
    clearStartRows();
    updateStartAddButton();
    // A saved ride's points 2..10 load after the form is up.
    startsReady = !editingRide;
    if (!editingRide) return;
    loadStarts(editingRide.id).then(function (res) {
      if (version !== formVersion) return;
      if (res.error) {
        // startsReady stays false, so this form cannot save over points it
        // never showed.
        showFormError("Couldn't load this ride's start points, so it can't be saved. " +
          "Close the form and open it again. (" + res.error.message + ")");
        return;
      }
      (res.data || []).forEach(function (point) {
        addStartRow(point);
      });
      updateStartAddButton();
      startsReady = true;
    });
  }

  // A new draft that starts from an earlier ride's settings (E3). It is a
  // new ride: create_ride() gives it its own id, no sign-up comes with it,
  // and the three times are left empty for the organizer to choose.
  function copyRide(ride) {
    openForm(null);
    // openForm() has just bumped formVersion; the copy's rows are dropped if
    // another form opens before its reply lands.
    var version = formVersion;
    fillRideForm(ride);
    [meetAtInput, departAtInput, deadlineInput].forEach(function (input) { input.value = ""; });
    formTitleEl.textContent = "New ride, copied from " + ride.title;
    // The copy keeps the source's places and map links (E3) but not its
    // times: the organizer picks new ones for every point. Saving waits for
    // them, so a quick save cannot drop them from the copy.
    startsReady = false;
    loadStarts(ride.id).then(function (res) {
      if (version !== formVersion) return;
      // A new ride has no points to lose, so a failed read only means none
      // are copied; the form can still save.
      startsReady = true;
      if (res.error) {
        showFormError("Couldn't copy the start points: " + res.error.message);
        return;
      }
      (res.data || []).forEach(function (point) {
        addStartRow({ place: point.place, map_link: point.map_link, start_at: null });
      });
      updateStartAddButton();
    });
  }

  function closeForm() {
    // A reply for the form that just closed (its start points, a route
    // file still being read) must not fill a hidden form.
    formVersion += 1;
    editingRide = null;
    formEl.hidden = true;
    clearFormError();
    showGpxStatus("");
  }

  // The first problem in form order as { input, message }, or null when the
  // ride is saveable. create_ride() and update_ride() check the same rules
  // again on the server.
  function firstRideProblem() {
    var title = inputFor("title");
    if (title.value.trim() === "") {
      return { input: title, message: "A title is required." };
    }
    var meetingPoint = inputFor("meeting_point");
    if (meetingPoint.value.trim() === "") {
      return { input: meetingPoint, message: "A meeting point is required." };
    }
    if (meetAtInput.value === "") {
      return { input: meetAtInput, message: "The meet-up time is required." };
    }
    if (deadlineInput.value === "") {
      return { input: deadlineInput, message: "The sign-up deadline is required." };
    }
    // An empty capacity means no limit (#96).
    var capacity = inputFor("capacity");
    var places = Number(capacity.value);
    if (capacity.value !== "" && (!Number.isInteger(places) || places < 1)) {
      return { input: capacity, message: "Capacity must be a whole number of 1 or more, or empty for no limit." };
    }
    // 0016's rules, checked again by create_ride() and update_ride().
    if (signupTypeInput.value === "name" && capacity.value !== "") {
      return { input: capacity, message: "A ride that takes typed names has no limit. " +
        "Empty the capacity, or choose PPK members." };
    }
    if (signupTypeInput.value === "fields" && checkedDetails().length === 0) {
      return { input: detailBox("bike_type"), message: "Pick at least one detail riders must give." };
    }
    if (departAtInput.value !== "" &&
        new Date(departAtInput.value).getTime() < new Date(meetAtInput.value).getTime()) {
      return { input: departAtInput, message: "The ride can't depart before its meet-up." };
    }
    if (new Date(deadlineInput.value).getTime() > new Date(meetAtInput.value).getTime()) {
      return { input: deadlineInput, message: "Sign-up must close by the meet-up time." };
    }
    return null;
  }

  // Every p_ argument by name; empty optional text and empty numbers go as
  // null, and the times are converted from local input to ISO (UTC).
  function ridePayload() {
    var payload = {};
    RIDE_FIELDS.forEach(function (field) {
      var value = inputFor(field.column).value.trim();
      if (value === "") {
        payload[field.param] = null;
      } else if (field.kind === "datetime") {
        payload[field.param] = new Date(value).toISOString();
      } else if (field.kind === "km") {
        payload[field.param] = Math.round(Number(value) * 1000);
      } else if (field.kind === "integer") {
        payload[field.param] = Number(value);
      } else {
        payload[field.param] = value;
      }
    });
    // Departure is optional in the form: an empty one means the ride leaves
    // at the meet-up time, which is what the database stores.
    if (payload.p_depart_at === null) payload.p_depart_at = payload.p_meet_at;
    payload.p_required_fields = payload.p_signup_type === "fields" ? checkedDetails() : [];
    return payload;
  }

  formEl.addEventListener("submit", function (event) {
    event.preventDefault();
    clearFormError();
    if (!startsReady) {
      showFormError("The start points haven't loaded yet. Wait a moment, or close the " +
        "form and open it again.");
      return;
    }
    // firstStartProblem() only runs once the ride's own fields pass, so
    // they are reported first; both are shown and focused the same way.
    var problem = firstRideProblem() || firstStartProblem();
    if (problem) {
      showFormError(problem.message);
      problem.input.focus();
      return;
    }
    saveButton.disabled = true;
    statusEl.textContent = "Saving...";
    var payload = ridePayload();
    var saved;
    if (editingRide) {
      payload.p_ride_id = editingRide.id;
      saved = client.rpc("update_ride", payload);
    } else {
      saved = client.rpc("create_ride", payload);
    }
    saved.then(function (res) {
      if (res.error) {
        saveButton.disabled = false;
        // The form keeps the organizer's input so they can correct it.
        statusEl.textContent = "";
        showFormError(res.error.message);
        return;
      }
      // create_ride() answers with the new ride's id; update_ride() has none,
      // so the form's own ride carries it. The extra points are a second
      // call: set_ride_starts() replaces them all at once.
      var rideId = editingRide ? editingRide.id : res.data;
      client.rpc("set_ride_starts", { p_ride_id: rideId, p_starts: startPayload() })
        .then(function (startRes) {
          saveButton.disabled = false;
          if (startRes.error) {
            // The ride itself is saved. A new one turns into an edit of
            // itself, so trying again updates that ride instead of creating
            // a second one.
            if (!editingRide) {
              editingRide = { id: rideId };
              formTitleEl.textContent = "Edit ride";
            }
            statusEl.textContent = "";
            showFormError("The ride was saved, but its start points were not: " +
              startRes.error.message);
            return;
          }
          closeForm();
          statusEl.textContent = "Ride saved.";
          loadRides();
        });
    });
  });

  // The deadline default applies until the organizer edits that field by
  // hand in this form. Departure is not copied from the meet-up any more:
  // copying on every keystroke could catch a half-typed time and keep it
  // (the first pilot ride got a 12:07 departure that way). An empty
  // departure is saved as the meet-up time instead (ridePayload).
  deadlineInput.addEventListener("input", function () { deadlineEdited = true; });
  deadlineInput.addEventListener("change", function () { deadlineEdited = true; });
  meetAtInput.addEventListener("input", function () {
    if (!deadlineEdited) deadlineInput.value = defaultDeadline(meetAtInput.value);
  });

  newButton.addEventListener("click", function () { openForm(null); });
  formCancelButton.addEventListener("click", closeForm);

  // ---------------------------------------------------- extra start points

  // Point 1 is the ride's own meeting point, map link and meet-up time;
  // points 2 to 10 live in session_starts (0009_ride_starts.sql), at most
  // nine rows here.
  var MAX_EXTRA_STARTS = 9;

  // A label wraps its own text and input, so a row needs no ids and every
  // label points at exactly the input it holds.
  function startLabel(text, input) {
    var label = document.createElement("label");
    label.textContent = text;
    label.appendChild(input);
    return label;
  }

  // One row in the order the points are numbered: place, map link, time,
  // then Remove. `point` is null for a new row, or { place, map_link,
  // start_at } from session_starts (start_at an ISO string or null). Returns
  // the place input so the caller can focus it.
  function addStartRow(point) {
    var row = document.createElement("div");
    row.className = "start-row";

    var placeInput = document.createElement("input");
    placeInput.type = "text";
    placeInput.maxLength = 200;
    placeInput.className = "start-place";
    if (point && point.place) placeInput.value = point.place;
    row.appendChild(startLabel("Place", placeInput));

    var mapInput = document.createElement("input");
    mapInput.type = "url";
    mapInput.maxLength = 500;
    mapInput.className = "start-map";
    if (point && point.map_link) mapInput.value = point.map_link;
    row.appendChild(startLabel("Map link", mapInput));

    var timeInput = document.createElement("input");
    timeInput.type = "datetime-local";
    timeInput.className = "start-time";
    // Stored times are ISO (UTC); the input speaks local wall time.
    if (point && point.start_at) timeInput.value = localDateTimeValue(point.start_at);
    row.appendChild(startLabel("Time", timeInput));

    row.appendChild(actionButton("Remove", function () {
      startsEl.removeChild(row);
      updateStartAddButton();
    }));
    startsEl.appendChild(row);
    return placeInput;
  }

  function clearStartRows() {
    clearChildren(startsEl);
  }

  // The rows' inputs in display order, which is point order.
  function startRowInputs() {
    var rows = [];
    var nodes = startsEl.querySelectorAll(".start-row");
    for (var i = 0; i < nodes.length; i += 1) {
      rows.push({
        place: nodes[i].querySelector(".start-place"),
        map: nodes[i].querySelector(".start-map"),
        time: nodes[i].querySelector(".start-time")
      });
    }
    return rows;
  }

  // The add button disappears at the limit the database also enforces.
  function updateStartAddButton() {
    startAddButton.hidden = startRowInputs().length >= MAX_EXTRA_STARTS;
  }

  // Reads a ride's points 2..10 in point order. The caller keeps the promise
  // so it can act on the rows once they arrive.
  function loadStarts(rideId) {
    return client.from("session_starts")
      .select("position, place, map_link, start_at")
      .eq("session_id", rideId)
      .order("position", { ascending: true });
  }

  // The first bad row in point order as { input, message }, or null. The
  // database checks the same places and times again (set_ride_starts).
  function firstStartProblem() {
    var rows = startRowInputs();
    for (var i = 0; i < rows.length; i += 1) {
      var number = i + 2;
      if (rows[i].place.value.trim() === "") {
        return { input: rows[i].place, message: "Start point " + number + " needs a place." };
      }
      if (rows[i].time.value === "") {
        return { input: rows[i].time, message: "Start point " + number + " needs a time." };
      }
    }
    return null;
  }

  // The rows as set_ride_starts() takes them: array order gives positions
  // 2, 3 and so on, an empty map link goes as null, and the times go as
  // ISO (UTC) strings.
  function startPayload() {
    return startRowInputs().map(function (row) {
      var mapLink = row.map.value.trim();
      return {
        place: row.place.value.trim(),
        map_link: mapLink === "" ? null : mapLink,
        start_at: new Date(row.time.value).toISOString()
      };
    });
  }

  startAddButton.addEventListener("click", function () {
    if (startRowInputs().length >= MAX_EXTRA_STARTS) {
      updateStartAddButton();
      return;
    }
    var placeInput = addStartRow(null);
    updateStartAddButton();
    placeInput.focus();
  });

  // ---------------------------------------------------------------- route file

  // A route file is far smaller; a bigger one is not a route.
  var GPX_MAX_BYTES = 20 * 1024 * 1024;
  var EARTH_RADIUS_M = 6371008.8;   // mean Earth radius, metres
  // GPS heights jitter by a few metres, so a rise counts only once it passes
  // this, which keeps noise out of the climbing total.
  var CLIMB_THRESHOLD_M = 5;
  var gpxPick = 0;   // bumped on every file pick, so only the latest read fills the form

  // Track points come first; a file without them falls back to its route
  // points. Poor positions are skipped, and a segment with fewer than two
  // points is no route.
  function gpxSegments(doc) {
    function readPoints(parent, tag) {
      var points = [];
      var nodes = parent.getElementsByTagNameNS("*", tag);
      for (var i = 0; i < nodes.length; i += 1) {
        var lat = parseFloat(nodes[i].getAttribute("lat"));
        var lon = parseFloat(nodes[i].getAttribute("lon"));
        if (!Number.isFinite(lat) || lat < -90 || lat > 90) continue;
        if (!Number.isFinite(lon) || lon < -180 || lon > 180) continue;
        // Some apps write 0,0 when they lose the GPS fix: off West Africa,
        // and never on a PPK ride.
        if (lat === 0 && lon === 0) continue;
        var eleNodes = nodes[i].getElementsByTagNameNS("*", "ele");
        var ele = eleNodes.length > 0 ? parseFloat(eleNodes[0].textContent) : NaN;
        points.push({ lat: lat, lon: lon, ele: Number.isFinite(ele) ? ele : null });
      }
      return points;
    }

    var segments = [];
    var tracks = doc.getElementsByTagNameNS("*", "trkseg");
    for (var i = 0; i < tracks.length; i += 1) {
      segments.push(readPoints(tracks[i], "trkpt"));
    }
    var trackPoints = 0;
    segments.forEach(function (segment) { trackPoints += segment.length; });
    if (trackPoints === 0) {
      segments = [];
      var routes = doc.getElementsByTagNameNS("*", "rte");
      for (var j = 0; j < routes.length; j += 1) {
        segments.push(readPoints(routes[j], "rtept"));
      }
    }
    return segments.filter(function (segment) { return segment.length >= 2; });
  }

  function haversineMetres(a, b) {
    var lat1 = a.lat * Math.PI / 180;
    var lat2 = b.lat * Math.PI / 180;
    var dLat = (b.lat - a.lat) * Math.PI / 180;
    var dLon = (b.lon - a.lon) * Math.PI / 180;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // Distance never crosses a segment. Climbing counts each rise from a
  // valley to the next peak. The reference follows the height up while
  // rising and down while falling. The direction turns only after a move of
  // CLIMB_THRESHOLD_M the other way, so jitter under it adds nothing, and no
  // part of a real hill is lost at its top or bottom.
  function routeSummary(segments) {
    var distance = 0;
    var climb = 0;
    var climbingSeen = false;
    var points = 0;
    segments.forEach(function (segment) {
      points += segment.length;
      for (var i = 1; i < segment.length; i += 1) {
        distance += haversineMetres(segment[i - 1], segment[i]);
      }
      // A segment starts as if falling, so its first climb needs a full
      // threshold before it counts, from the lowest point before it.
      var ref = null;
      var rising = false;
      for (var j = 0; j < segment.length; j += 1) {
        var ele = segment[j].ele;
        if (ele === null) continue;
        climbingSeen = true;
        if (ref === null) {
          ref = ele;
        } else if (rising) {
          if (ele > ref) {
            climb += ele - ref;
            ref = ele;
          } else if (ref - ele >= CLIMB_THRESHOLD_M) {
            rising = false;
            ref = ele;
          }
        } else if (ele < ref) {
          ref = ele;
        } else if (ele - ref >= CLIMB_THRESHOLD_M) {
          rising = true;
          climb += ele - ref;
          ref = ele;
        }
      }
    });
    return {
      distance_m: distance,
      climbing_m: climbingSeen ? climb : null,
      points: points
    };
  }

  // The XML is parsed here, in the browser: the file never leaves it.
  function readGpx(text) {
    var doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.getElementsByTagName("parsererror").length > 0 ||
        !doc.documentElement ||
        doc.documentElement.localName !== "gpx") {
      return { error: "That file isn't a GPX file this page can read." };
    }
    var segments = gpxSegments(doc);
    if (segments.length === 0) {
      return { error: "That file has no route or track points." };
    }
    var summary = routeSummary(segments);
    if (summary.distance_m < 100) {
      return { error: "The route in that file is under 0.1 km." };
    }
    return { summary: summary };
  }

  function showGpxStatus(message) {
    gpxStatusEl.textContent = message;
  }

  function gpxSummaryText(fileName, summary) {
    var km = (summary.distance_m / 1000).toFixed(1);
    if (summary.climbing_m === null) {
      return "Read from " + fileName + ": " + km + " km. The file has no heights, " +
        "so climbing is unchanged. Check the distance, then save.";
    }
    var metres = String(Math.round(summary.climbing_m));
    return "Read from " + fileName + ": " + km + " km and " + metres +
      " m of climbing. Check both, then save.";
  }

  // The read is local and never sent anywhere; the inputs stay editable.
  function readGpxFile() {
    var file = gpxInput.files && gpxInput.files[0];
    gpxPick += 1;
    var pick = gpxPick;
    showGpxStatus("");
    if (!file) return;
    if (file.size > GPX_MAX_BYTES) {
      showGpxStatus("That file is over 20 MB, too big for a route file.");
      return;
    }
    var version = formVersion;
    showGpxStatus("Reading " + file.name + "...");
    var reader = new FileReader();
    reader.onload = function () {
      // The form was closed or reopened while the file was read, or another
      // file was picked since, so this result is not the one on screen.
      if (version !== formVersion || pick !== gpxPick) return;
      var result = readGpx(String(reader.result));
      if (result.error) {
        showGpxStatus(result.error);
        return;
      }
      inputFor("distance_km").value = (result.summary.distance_m / 1000).toFixed(1);
      if (result.summary.climbing_m !== null) {
        inputFor("climbing_m").value = String(Math.round(result.summary.climbing_m));
      }
      showGpxStatus(gpxSummaryText(file.name, result.summary));
    };
    reader.onerror = function () {
      if (version !== formVersion || pick !== gpxPick) return;
      showGpxStatus("Couldn't read that file.");
    };
    reader.readAsText(file);
  }

  gpxInput.addEventListener("change", readGpxFile);

  // ---------------------------------------------------------------- roster

  function attendanceText(attendance) {
    if (attendance === null || attendance === undefined) return "not marked";
    if (attendance === "no_show") return "no-show";
    return String(attendance);
  }

  // A tel: href is built only from digits, +, spaces and dashes, so nothing
  // else a stored phone number might carry can reach the link.
  function telHref(phone) {
    if (phone === null || phone === undefined) return "";
    var cleaned = String(phone).replace(/[^0-9+ -]/g, "").trim();
    return cleaned === "" ? "" : "tel:" + cleaned;
  }

  function canMarkAttendance(ride, signup) {
    return ride.status === "published" && signup.status === "confirmed" && rideHasStarted(ride);
  }

  function markAttendance(ride, signup, attendance) {
    clearOrganizeError();
    client.rpc("mark_attendance", { p_signup_id: signup.signup_id, p_attendance: attendance })
      .then(function (res) {
        if (res.error) {
          showOrganizeError(res.error.message);
          return;
        }
        if (rosterRide !== ride) return;
        loadRoster(ride);
      });
  }

  // The start line for one rider. Position 1 (or no row in the choices) is
  // the ride's own point; a later position is session_starts' row for it.
  function startJoinText(ride, signup, joinInfo) {
    var position = joinInfo.positions[signup.signup_id] || 1;
    if (position === 1) {
      return "Starts at: " + formatMeetAt(ride.meet_at) + " at " + ride.meeting_point;
    }
    var point = joinInfo.points[position];
    if (!point) return "Starts at: start point " + position;
    return "Starts at: " + formatMeetAt(point.start_at) + " at " + point.place;
  }

  // The ride's day in Malaysia time, as 0013's ride_emergency_contacts()
  // counts it. The server refuses on any other day; this only avoids asking.
  function malaysiaDate(value) {
    return new Date(value).toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
  }

  function isRideDay(ride) {
    return malaysiaDate(ride.meet_at) === malaysiaDate(Date.now());
  }

  // One line per rider on the ride day (#97): the contact the rider shared,
  // or that they haven't shared one.
  function emergencyLine(signup, contacts) {
    var line = document.createElement("div");
    var contact = contacts[signup.signup_id];
    if (!contact) {
      line.textContent = "Emergency contact: not shared";
      return line;
    }
    line.appendChild(document.createTextNode("Emergency contact: " + (contact.contact_name || "") +
      (contact.relationship ? " (" + contact.relationship + ")" : "") + " "));
    var href = telHref(contact.contact_phone);
    if (href) {
      var link = document.createElement("a");
      link.href = href;
      link.textContent = contact.contact_phone;
      line.appendChild(link);
    }
    return line;
  }

  // A type 3 ride's details for one confirmed rider (0016): only those the
  // ride asks for, and "not given" for one a rider joined without (they
  // joined before the ride asked for it).
  function detailsLine(ride, signup, details) {
    var row = details[signup.signup_id] || {};
    var parts = DETAIL_FIELDS.filter(function (detail) {
      return (ride.required_fields || []).indexOf(detail.name) !== -1;
    }).map(function (detail) {
      var value = row[detail.name];
      return detail.label + ": " + (value === null || value === undefined || value === "" ? "not given" : value);
    });
    return textBlock("div", parts.join("; "));
  }

  function rosterItem(ride, signup, joinInfo, contacts, details) {
    var item = document.createElement("li");
    item.appendChild(textBlock("strong", signup.rider_name || "Name not given"));
    var href = telHref(signup.phone);
    if (href) {
      var phoneLink = document.createElement("a");
      phoneLink.href = href;
      phoneLink.textContent = signup.phone;
      item.appendChild(document.createTextNode(" "));
      item.appendChild(phoneLink);
    }
    item.appendChild(textBlock("div", "Sign-up: " + signup.status));
    item.appendChild(textBlock("div", "Attendance: " + attendanceText(signup.attendance)));
    // joinInfo is null unless the ride has an extra point, so a ride with
    // only its own point shows no line.
    if (joinInfo) item.appendChild(textBlock("div", startJoinText(ride, signup, joinInfo)));
    if (contacts && signup.status === "confirmed") item.appendChild(emergencyLine(signup, contacts));
    if (details && signup.status === "confirmed") item.appendChild(detailsLine(ride, signup, details));
    if (canMarkAttendance(ride, signup)) {
      item.appendChild(actionButton("Attended", function () {
        markAttendance(ride, signup, "attended");
      }));
      item.appendChild(actionButton("No-show", function () {
        markAttendance(ride, signup, "no_show");
      }));
    }
    return item;
  }

  // A typed name (0014) has no account behind it: no phone, attendance or
  // contact, only the name, when it was added, and a way to remove it.
  function nameRosterItem(ride, entry) {
    var item = document.createElement("li");
    item.appendChild(textBlock("strong", entry.rider_name));
    item.appendChild(document.createTextNode(" "));
    item.appendChild(textBlock("span", "(typed name, no account)", "note"));
    item.appendChild(textBlock("div", "Added: " + formatMeetAt(entry.signed_up_at)));
    var button = actionButton("Remove", function () { removeNameSignup(ride, entry, button); });
    item.appendChild(button);
    return item;
  }

  function removeNameSignup(ride, entry, button) {
    if (!window.confirm("Remove " + entry.rider_name + " from this ride?")) return;
    clearOrganizeError();
    button.disabled = true;
    client.rpc("remove_name_signup", { p_name_signup_id: entry.name_signup_id })
      .then(function (res) {
        button.disabled = false;
        if (res.error) {
          showOrganizeError(res.error.message);
          return;
        }
        if (rosterRide !== ride) return;
        loadRoster(ride);
      });
  }

  function loadRoster(ride) {
    clearOrganizeError();
    rosterVersion += 1;
    var version = rosterVersion;
    clearChildren(rosterListEl);
    rosterEmptyEl.hidden = true;
    rosterData = null;
    rosterDownloadButton.disabled = true;
    // One screen, six reads: the roster itself, the point each rider chose
    // (ride_start_choices), the ride's extra points, the ride-day emergency
    // contacts, the typed names (0014) and a type 3 ride's details (0016).
    // A failed choices or points read only drops the start line, and a
    // failed typed-names or details read only drops those, never the
    // roster; the usual error banner reports them.
    Promise.all([
      client.rpc("ride_roster", { p_ride_id: ride.id }),
      client.rpc("ride_start_choices", { p_ride_id: ride.id }),
      loadStarts(ride.id),
      isRideDay(ride)
        ? client.rpc("ride_emergency_contacts", { p_ride_id: ride.id })
        : Promise.resolve({ data: null, error: null }),
      client.rpc("ride_name_roster", { p_ride_id: ride.id }),
      ride.signup_type === "fields"
        ? client.rpc("ride_required_fields", { p_ride_id: ride.id })
        : Promise.resolve({ data: null, error: null })
    ]).then(function (results) {
      // A reply for a roster that has been closed or replaced is dropped.
      if (version !== rosterVersion || rosterRide !== ride) return;
      var rosterRes = results[0];
      if (rosterRes.error) {
        showOrganizeError(rosterRes.error.message);
        return;
      }
      var choicesRes = results[1];
      var startsRes = results[2];
      var joinInfo = null;
      // A file from a partly read roster would put riders at the wrong start
      // or leave typed names out, so it is offered only when both read.
      var complete = !choicesRes.error && !startsRes.error && !results[4].error;
      if (choicesRes.error || startsRes.error) {
        showOrganizeError((choicesRes.error || startsRes.error).message);
      } else {
        var positions = {};
        (choicesRes.data || []).forEach(function (choice) {
          positions[choice.signup_id] = choice.start_position;
        });
        var points = {};
        (startsRes.data || []).forEach(function (point) {
          points[point.position] = point;
        });
        // With no extra point the only place to join is the ride's own.
        if (Object.keys(points).length > 0) {
          joinInfo = { positions: positions, points: points };
        }
      }
      // Emergency contacts only on the ride day; a failed read drops the
      // lines, never the roster, and says why.
      var contactsRes = results[3];
      var contacts = null;
      if (contactsRes.error) {
        showOrganizeError(contactsRes.error.message);
      } else if (contactsRes.data) {
        contacts = {};
        contactsRes.data.forEach(function (contact) { contacts[contact.signup_id] = contact; });
      }
      var detailsRes = results[5];
      var details = null;
      if (detailsRes.error) {
        showOrganizeError(detailsRes.error.message);
      } else if (detailsRes.data) {
        details = {};
        detailsRes.data.forEach(function (row) { details[row.signup_id] = row; });
      }
      var signups = rosterRes.data || [];
      signups.forEach(function (signup) {
        rosterListEl.appendChild(rosterItem(ride, signup, joinInfo, contacts, details));
      });
      var namesRes = results[4];
      var names = [];
      if (namesRes.error) {
        showOrganizeError(namesRes.error.message);
      } else {
        names = namesRes.data || [];
      }
      names.forEach(function (entry) {
        rosterListEl.appendChild(nameRosterItem(ride, entry));
      });
      rosterEmptyEl.hidden = signups.length + names.length > 0;
      if (complete) {
        rosterData = { ride: ride, signups: signups, names: names, joinInfo: joinInfo };
        rosterDownloadButton.disabled = false;
      }
    });
  }

  // ------------------------------------------------------- roster download

  // Hubert, 2026-10-07 (#93, #125): the file holds names, start points,
  // sign-up status and attendance only. Phone numbers, emergency contacts
  // and a type 3 ride's details stay on screen, so a forwarded file shows
  // little.
  var CSV_HEADER = ["Name", "Signed up as", "Start point", "Start time (Malaysia)", "Sign-up",
    "Attendance"];

  // The file says Malaysia time, so its times are Malaysia time whatever
  // zone the organizer's device is set to.
  function malaysiaTime(value) {
    return new Date(value).toLocaleString("en-GB", { timeZone: "Asia/Kuala_Lumpur",
      dateStyle: "medium", timeStyle: "short" });
  }

  // Where a member starts, as the roster's start line works it out: position
  // 1, or no choice, is the ride's own point.
  function startOf(ride, signup, joinInfo) {
    var position = joinInfo ? joinInfo.positions[signup.signup_id] || 1 : 1;
    var point = position === 1 ? null : joinInfo.points[position];
    if (position !== 1 && !point) return { place: "start point " + position, at: "" };
    return point
      ? { place: point.place, at: malaysiaTime(point.start_at) }
      : { place: ride.meeting_point || "", at: malaysiaTime(ride.meet_at) };
  }

  // RFC 4180: every cell quoted, quotes doubled. A cell a spreadsheet would
  // read as a formula (=, +, -, @, or a tab or return first) gets a leading
  // apostrophe, so a typed name can't run anything when the file is opened.
  function csvCell(value) {
    var text = value === null || value === undefined ? "" : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }

  function csvLine(cells) {
    return cells.map(csvCell).join(",");
  }

  // The generation time for the file name, in UTC, as "20261010T0630Z": no
  // character a file system refuses.
  function fileStamp(date) {
    return date.toISOString().slice(0, 16).replace(/[-:]/g, "") + "Z";
  }

  function rosterCsv(data, generated) {
    var ride = data.ride;
    var lines = [
      csvLine(["Ride", ride.title]),
      csvLine(["Meets", malaysiaTime(ride.meet_at) + " Malaysia time at " + (ride.meeting_point || "")]),
      csvLine(["Generated", generated.toISOString().slice(0, 19) + "Z (UTC), " +
        malaysiaTime(generated) + " Malaysia time"]),
      "",
      csvLine(CSV_HEADER)
    ];
    data.signups.forEach(function (signup) {
      var start = startOf(ride, signup, data.joinInfo);
      lines.push(csvLine([signup.rider_name || "Name not given", "member", start.place, start.at,
        signup.status, attendanceText(signup.attendance)]));
    });
    // A typed name has no start choice, sign-up status or attendance (0014).
    data.names.forEach(function (entry) {
      lines.push(csvLine([entry.rider_name, "typed name", ride.meeting_point || "",
        malaysiaTime(ride.meet_at), "typed name", ""]));
    });
    return lines.join("\r\n") + "\r\n";
  }

  // The file is made here, from the roster already on screen: nothing is
  // sent anywhere. The byte order mark lets a spreadsheet read names in any
  // script as UTF-8.
  function downloadRoster() {
    if (!rosterData) return;
    var generated = new Date();
    var text = String.fromCharCode(0xFEFF) + rosterCsv(rosterData, generated);
    var blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = "ppk-roster-" + malaysiaDate(rosterData.ride.meet_at) +
      "-generated-" + fileStamp(generated) + ".csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    // Safari fails a download whose URL is revoked at once, so it waits.
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  function openRoster(ride) {
    rosterRide = ride;
    rosterEl.hidden = false;
    rosterTitleEl.textContent = "Roster: " + ride.title;
    rosterNoteEl.textContent = rideHasStarted(ride)
      ? ""
      : "Attendance can be marked once the ride has started.";
    loadRoster(ride);
  }

  function closeRoster() {
    rosterRide = null;
    rosterVersion += 1;
    rosterData = null;
    rosterDownloadButton.disabled = true;
    clearChildren(rosterListEl);
    rosterEmptyEl.hidden = true;
    rosterEl.hidden = true;
  }

  rosterCloseButton.addEventListener("click", closeRoster);
  rosterDownloadButton.addEventListener("click", downloadRoster);

  // ---------------------------------------------------------------- wiring

  client.auth.getSession().then(function (res) {
    applySession(res.data.session);
  });
  client.auth.onAuthStateChange(function (event, session) {
    if (event === "SIGNED_OUT") {
      showSignedOut();
      return;
    }
    if (event === "SIGNED_IN" && session) applySession(session);
  });
})();
