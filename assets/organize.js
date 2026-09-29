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

  // Exactly the columns 0006_rides.sql grants. select("*") is refused,
  // because created_by is not readable.
  var RIDE_SELECT =
    "id, title, meeting_point, meeting_map_link, meet_at, depart_at, " +
    "route_link, distance_m, climbing_m, regroup_policy, pace_note, " +
    "capacity, signup_deadline, status";

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
  var saveButton = document.getElementById("ride-save");
  var formCancelButton = document.getElementById("ride-form-cancel");
  var formErrorEl = document.getElementById("ride-form-error");
  var listEl = document.getElementById("ride-list");
  var listEmptyEl = document.getElementById("ride-list-empty");
  var rosterEl = document.getElementById("roster");
  var rosterTitleEl = document.getElementById("roster-title");
  var rosterNoteEl = document.getElementById("roster-note");
  var rosterListEl = document.getElementById("roster-list");
  var rosterEmptyEl = document.getElementById("roster-empty");
  var rosterCloseButton = document.getElementById("roster-close");
  var statusEl = document.getElementById("organize-status");
  var errorEl = document.getElementById("organize-error");

  var client = supabase.createClient(rootEl.dataset.supabaseUrl, rootEl.dataset.supabaseKey);

  var startedUserId = null;   // whose access check has already run
  var listVersion = 0;        // bumped on every rides reload, drops stale replies
  var editingRide = null;     // the ride the form is editing, or null for a new one
  var deadlineEdited = false; // the deadline was typed by hand in this form
  var rosterRide = null;      // the ride whose roster is on screen, or null
  var rosterVersion = 0;      // bumped on every roster load, drops stale replies

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

  // 8pm the evening before the meet-up: the sign-up deadline default (#33).
  function defaultDeadline(meetAtValue) {
    var meet = new Date(meetAtValue);
    if (Number.isNaN(meet.getTime())) return "";
    var eveningBefore = new Date(meet.getFullYear(), meet.getMonth(), meet.getDate() - 1, 20, 0);
    return localDateTimeText(eveningBefore);
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
      places.textContent = (res.data || 0) + " of " + ride.capacity + " places taken";
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
  }

  function openForm(ride) {
    editingRide = ride || null;
    // A saved ride's deadline was chosen already: moving its meet-up must not
    // quietly reset it. Only a new ride gets the 8pm default.
    deadlineEdited = Boolean(editingRide);
    formEl.reset();
    fillRideForm(editingRide);
    formTitleEl.textContent = editingRide ? "Edit ride" : "New ride";
    clearFormError();
    formEl.hidden = false;
    inputFor("title").focus();
  }

  function closeForm() {
    editingRide = null;
    formEl.hidden = true;
    clearFormError();
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
    if (departAtInput.value === "") {
      return { input: departAtInput, message: "The departure time is required." };
    }
    if (deadlineInput.value === "") {
      return { input: deadlineInput, message: "The sign-up deadline is required." };
    }
    var capacity = inputFor("capacity");
    var places = Number(capacity.value);
    if (capacity.value === "" || !Number.isInteger(places) || places < 1) {
      return { input: capacity, message: "Capacity must be a whole number of 1 or more." };
    }
    if (new Date(departAtInput.value).getTime() < new Date(meetAtInput.value).getTime()) {
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
    return payload;
  }

  formEl.addEventListener("submit", function (event) {
    event.preventDefault();
    clearFormError();
    var problem = firstRideProblem();
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
      saveButton.disabled = false;
      if (res.error) {
        // The form keeps the organizer's input so they can correct it.
        statusEl.textContent = "";
        showFormError(res.error.message);
        return;
      }
      closeForm();
      statusEl.textContent = "Ride saved.";
      loadRides();
    });
  });

  // The deadline default applies until the organizer edits that field by
  // hand in this form; a departure left empty follows the meet-up time.
  deadlineInput.addEventListener("input", function () { deadlineEdited = true; });
  deadlineInput.addEventListener("change", function () { deadlineEdited = true; });
  meetAtInput.addEventListener("input", function () {
    if (!deadlineEdited) deadlineInput.value = defaultDeadline(meetAtInput.value);
    if (departAtInput.value === "") departAtInput.value = meetAtInput.value;
  });

  newButton.addEventListener("click", function () { openForm(null); });
  formCancelButton.addEventListener("click", closeForm);

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

  function rosterItem(ride, signup) {
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

  function loadRoster(ride) {
    clearOrganizeError();
    rosterVersion += 1;
    var version = rosterVersion;
    clearChildren(rosterListEl);
    rosterEmptyEl.hidden = true;
    client.rpc("ride_roster", { p_ride_id: ride.id }).then(function (res) {
      // A reply for a roster that has been closed or replaced is dropped.
      if (version !== rosterVersion || rosterRide !== ride) return;
      if (res.error) {
        showOrganizeError(res.error.message);
        return;
      }
      var signups = res.data || [];
      signups.forEach(function (signup) {
        rosterListEl.appendChild(rosterItem(ride, signup));
      });
      rosterEmptyEl.hidden = signups.length > 0;
    });
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
    clearChildren(rosterListEl);
    rosterEmptyEl.hidden = true;
    rosterEl.hidden = true;
  }

  rosterCloseButton.addEventListener("click", closeRoster);

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
