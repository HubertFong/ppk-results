/* The PPK member account page: sign-in by magic link or code, the member's
 * profile, and their achievement awards.
 *
 * A classic script, loaded at the end of the body by site_account.py, so every
 * element below already exists when it runs. Its only dependency is the
 * global `supabase` from the pinned supabase-js tag on the same page.
 * Config comes from #account-root's data attributes, never from inline text.
 */
(function () {
  "use strict";

  // Turnstile's script is deferred and calls these later, so they have to be
  // on window from this script's first synchronous run.
  var captchaToken = null;
  window.ppkTurnstileSuccess = function (token) { captchaToken = token; };
  window.ppkTurnstileExpired = function () { captchaToken = null; };

  // The columns of `profiles`, in the order the form shows them. The labels
  // are the form's own labels, reused in the validation messages. A "choice"
  // is a dropdown whose options are in the page. club and kit_size stay in
  // the table, off the form (#92). A prefill shows when the column is empty,
  // and is saved as empty if left as it is.
  var PROFILE_FIELDS = [
    { column: "full_name", label: "Full name", kind: "text", maxLength: 120 },
    { column: "preferred_name", label: "Preferred name", kind: "text", maxLength: 60 },
    { column: "phone", label: "Phone", kind: "text", maxLength: 32, prefill: "+60" },
    { column: "date_of_birth", label: "Date of birth", kind: "date" },
    { column: "gender", label: "Gender", kind: "choice" },
    { column: "years_riding", label: "Years riding", kind: "number" },
    { column: "kit_top_size", label: "Kit size (top)", kind: "choice" },
    { column: "kit_bottom_size", label: "Kit size (bottom)", kind: "choice" },
    { column: "bike_type", label: "Bike type", kind: "choice" },
    { column: "whatsapp_opt_in", label: "PPK may contact me on WhatsApp", kind: "checkbox" },
    { column: "email_opt_in", label: "PPK may contact me by email", kind: "checkbox" }
  ];
  var PROFILE_COLUMNS = PROFILE_FIELDS.map(function (field) { return field.column; });
  var PROFILE_SELECT = PROFILE_COLUMNS.join(", ");
  var ACHIEVEMENT_SELECT =
    "granted_at, achievement_definitions(label, description, display_order)";
  var OLDEST_BIRTH_DATE = "1900-01-01";
  // Full name, phone and date of birth are required: 0013's
  // safety_set_complete() needs them before a member can join a ride (#97).
  var REQUIRED_COLUMNS = ["full_name", "phone", "date_of_birth"];
  var SAFETY_SELECT =
    "contact_name, relationship, contact_phone, risk_ack_version, risk_ack_at, " +
    "organizer_share_consent_at";
  var GUARDIAN = "Parent or guardian";

  var rootEl = document.getElementById("account-root");
  var formEl = document.getElementById("account-form");
  var emailEl = document.getElementById("account-email");
  var sendButton = document.getElementById("account-send");
  var sentEl = document.getElementById("account-sent");
  var sentEmailEl = document.getElementById("account-sent-email");
  var signedInEl = document.getElementById("account-signed-in");
  var userEmailEl = document.getElementById("account-user-email");
  var signOutButton = document.getElementById("account-signout");
  var codeFormEl = document.getElementById("account-code-form");
  var codeEl = document.getElementById("account-code");
  var verifyButton = document.getElementById("account-verify");
  var errorEl = document.getElementById("account-error");
  var profileFormEl = document.getElementById("profile-form");
  var profileSaveButton = document.getElementById("profile-save");
  var profileStatusEl = document.getElementById("profile-status");
  var profileErrorEl = document.getElementById("profile-error");
  var achievementsListEl = document.getElementById("achievements-list");
  var achievementsEmptyEl = document.getElementById("achievements-empty");
  var achievementsErrorEl = document.getElementById("achievements-error");
  var organizerEl = document.getElementById("account-organizer");
  var safetyRequiredEl = document.getElementById("safety-required");
  var optionalGroupEl = document.getElementById("profile-optional-group");
  var achievementsSectionEl = document.getElementById("achievements");
  var safetyFormEl = document.getElementById("safety-form");
  var safetyNameEl = document.getElementById("safety-contact_name");
  var safetyRelationshipEl = document.getElementById("safety-relationship");
  var safetyPhoneEl = document.getElementById("safety-contact_phone");
  var safetyAcceptEl = document.getElementById("safety-accept");
  var safetyConsentEl = document.getElementById("safety-consent");
  var safetyMinorNoteEl = document.getElementById("safety-minor-note");
  var safetySaveButton = document.getElementById("safety-save");
  var safetyStatusEl = document.getElementById("safety-status");
  var safetyErrorEl = document.getElementById("safety-error");
  // The version of the ride terms this page shows. It must match 0013's
  // current_risk_ack_version(), or the acceptance would not count.
  var TERMS_VERSION = document.getElementById("safety-terms").dataset.version;

  var client = supabase.createClient(rootEl.dataset.supabaseUrl, rootEl.dataset.supabaseKey);
  var captchaRequired = rootEl.dataset.captchaRequired === "true";

  var currentUser = null;   // the signed-in member, or null
  var loadedUserId = null;  // whose profile and achievements are already shown

  function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function profileInput(column) {
    return document.getElementById("profile-" + column);
  }

  function showError(message) {
    errorEl.textContent = "Something went wrong: " + message + ". Please try again in a moment.";
    errorEl.hidden = false;
  }

  // ------------------------------------------------------ sign in / out

  function safeReturnTo(raw) {
    if (!raw) return null;
    try {
      var target = new URL(raw, window.location.origin);
      if (target.origin !== window.location.origin || !target.pathname.startsWith("/")) return null;
      return target.pathname + target.search + target.hash;
    } catch (error) {
      return null;
    }
  }

  // A magic link often opens in a new tab, and session storage belongs to
  // one tab. localStorage is shared by the browser's tabs, so the target is
  // kept there. It is used once and ignored after an hour, so an old one
  // can't pull a member away from this page later.
  var RETURN_TO_KEY = "ppkReturnTo";
  var RETURN_TO_MAX_AGE_MS = 60 * 60 * 1000;

  var accountUrl = new URL(window.location.href);
  var returnTo = safeReturnTo(accountUrl.searchParams.get("returnTo"));
  accountUrl.searchParams.delete("returnTo");
  if (returnTo) {
    try {
      localStorage.setItem(RETURN_TO_KEY, JSON.stringify({ to: returnTo, at: Date.now() }));
    } catch (error) {
      // Blocked storage only means the member stays here after signing in.
    }
  }

  function takeSavedReturnTo() {
    var saved = null;
    try {
      var raw = localStorage.getItem(RETURN_TO_KEY);
      localStorage.removeItem(RETURN_TO_KEY);
      saved = JSON.parse(raw);
    } catch (error) {
      return null;
    }
    if (!saved || typeof saved.at !== "number" || Date.now() - saved.at > RETURN_TO_MAX_AGE_MS) {
      return null;
    }
    return safeReturnTo(saved.to);
  }

  // A member whose safety set is incomplete stays here to finish it; the
  // saved target waits until it is done (#97), so the rides page and this
  // page never send a member back and forth.
  function returnToSavedContext(session) {
    if (!session) return;
    refreshSafety(session.user.id).then(function (complete) {
      if (!complete) return;
      var savedReturnTo = takeSavedReturnTo();
      if (savedReturnTo) window.location.assign(savedReturnTo);
    });
  }

  function render(session) {
    errorEl.hidden = true;
    if (session) {
      showSignedIn(session.user);
    } else {
      showSignedOut();
    }
  }

  function showSignedIn(user) {
    currentUser = user;
    formEl.hidden = true;
    sentEl.hidden = true;
    codeFormEl.hidden = true;
    signedInEl.hidden = false;
    userEmailEl.textContent = user.email || "";
    // render() runs twice at start-up (getSession and INITIAL_SESSION), so
    // only the first one for this user id goes to the database.
    if (user.id === loadedUserId) return;
    loadedUserId = user.id;
    loadProfile(user.id);
    loadSafety(user.id);
    loadAchievements(user.id);
    checkOrganizer(user.id);
  }

  // Leaves nothing of the member's session on screen.
  function showSignedOut() {
    currentUser = null;
    loadedUserId = null;
    signedInEl.hidden = true;
    formEl.hidden = false;
    sentEl.hidden = true;
    codeFormEl.hidden = false;
    codeEl.value = "";
    profileFormEl.reset();
    profileStatusEl.textContent = "";
    clearProfileError();
    clearAchievementsError();
    clearChildren(achievementsListEl);
    achievementsEmptyEl.hidden = true;
    organizerEl.hidden = true;
    safetyFormEl.reset();
    loadedSafetyRow = null;
    safetyStatusEl.textContent = "";
    clearSafetyError();
    safetyMinorNoteEl.hidden = true;
    applyGate(false);
    safetyRequiredEl.hidden = true;
  }

  // ---------------------------------------------------------- profile

  function clearProfileError() {
    profileErrorEl.textContent = "";
    profileErrorEl.hidden = true;
  }

  function showProfileError(message) {
    profileErrorEl.textContent = message;
    profileErrorEl.hidden = false;
  }

  // A null row means the member has no profile row yet: every field empty,
  // or showing its prefill.
  function fillProfileForm(row) {
    PROFILE_FIELDS.forEach(function (field) {
      var input = profileInput(field.column);
      var value = row ? row[field.column] : null;
      if (field.kind === "checkbox") {
        input.checked = value === true;
      } else if (value === null || value === undefined || value === "") {
        input.value = field.prefill || "";
      } else {
        input.value = String(value);
        // An old free-text answer that isn't on the list shows as "Not given".
        if (field.kind === "choice" && input.selectedIndex === -1) input.value = "";
      }
    });
  }

  // A reply that arrives after sign-out, or after another member signed in,
  // must not put the earlier member's data back on screen.
  function stillShowing(userId) {
    return loadedUserId === userId;
  }

  function loadProfile(userId) {
    clearProfileError();
    profileStatusEl.textContent = "";
    client.from("profiles")
      .select(PROFILE_SELECT)
      .eq("user_id", userId)
      .maybeSingle()
      .then(function (res) {
        if (!stillShowing(userId)) return;
        if (res.error) {
          showProfileError("Couldn't load your profile: " + res.error.message);
          return;
        }
        fillProfileForm(res.data);
      });
  }

  function todayIso() {
    var now = new Date();
    var month = String(now.getMonth() + 1).padStart(2, "0");
    var day = String(now.getDate()).padStart(2, "0");
    return now.getFullYear() + "-" + month + "-" + day;
  }

  // True only for a real calendar day, so 2026-02-31 is rejected.
  function isRealDate(value) {
    var parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!parts) return false;
    var year = Number(parts[1]);
    var month = Number(parts[2]) - 1;
    var day = Number(parts[3]);
    var date = new Date(year, month, day);
    return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day;
  }

  // Checks the eleven fields in form order and returns the first problem as
  // { input, message }, or null when every field is saveable.
  function firstProfileProblem() {
    for (var i = 0; i < PROFILE_FIELDS.length; i++) {
      var field = PROFILE_FIELDS[i];
      var input = profileInput(field.column);
      var value = input.value.trim();
      if (REQUIRED_COLUMNS.indexOf(field.column) !== -1 &&
          (value === "" || value === field.prefill)) {
        return { input: input, message: field.label + " is required." };
      }
      // Array.from counts characters as Postgres's char_length does; .length
      // would count an emoji twice.
      if (field.kind === "text" && Array.from(value).length > field.maxLength) {
        return { input: input,
                 message: field.label + " must be " + field.maxLength + " characters or fewer." };
      }
      if (field.kind === "number" && value !== "") {
        var years = Number(value);
        if (!Number.isInteger(years) || years < 0 || years > 100) {
          return { input: input,
                   message: field.label + " must be a whole number from 0 to 100." };
        }
      }
      if (field.kind === "date" && value !== "") {
        if (!isRealDate(value)) {
          return { input: input, message: field.label + " must be a real date, like 1990-04-23." };
        }
        if (value < OLDEST_BIRTH_DATE) {
          return { input: input, message: field.label + " can't be before 1 January 1900." };
        }
        if (value > todayIso()) {
          return { input: input, message: field.label + " can't be in the future." };
        }
      }
    }
    return null;
  }

  // Exactly the eleven form columns plus user_id. 0011's column grants let a
  // member write nothing else, and the upsert needs both grants on each one.
  function profilePayload(userId) {
    var payload = { user_id: userId };
    PROFILE_FIELDS.forEach(function (field) {
      var input = profileInput(field.column);
      if (field.kind === "checkbox") {
        payload[field.column] = input.checked;
        return;
      }
      var value = input.value.trim();
      // A bare prefill, the phone's "+60", means nothing was typed.
      if (value === "" || value === field.prefill) {
        payload[field.column] = null;
      } else if (field.kind === "number") {
        payload[field.column] = Number(value);
      } else {
        payload[field.column] = value;
      }
    });
    return payload;
  }

  // Migrations 0005 and 0011 name each check profiles_<column>_<rule>, such
  // as profiles_kit_top_size_length, so the name tells us which field to
  // point at.
  function saveErrorMessage(error) {
    var message = (error && error.message) ? error.message : "unknown error";
    for (var i = 0; i < PROFILE_FIELDS.length; i++) {
      var field = PROFILE_FIELDS[i];
      if (message.indexOf("profiles_" + field.column + "_") !== -1) {
        return "Couldn't save: please check " + field.label + ".";
      }
    }
    return "Couldn't save: " + message;
  }

  profileFormEl.addEventListener("submit", function (event) {
    event.preventDefault();
    if (!currentUser) {
      showProfileError("You need to sign in again before saving.");
      return;
    }
    clearProfileError();
    var problem = firstProfileProblem();
    if (problem) {
      showProfileError(problem.message);
      problem.input.focus();
      return;
    }
    profileSaveButton.disabled = true;
    profileStatusEl.textContent = "Saving...";
    client.from("profiles")
      .upsert(profilePayload(currentUser.id), { onConflict: "user_id" })
      .select(PROFILE_SELECT)
      .single()
      .then(function (res) {
        profileSaveButton.disabled = false;
        if (res.error) {
          // The form keeps the member's input so they can correct it.
          showProfileError(saveErrorMessage(res.error));
          return;
        }
        profileStatusEl.textContent = "Saved.";
        fillProfileForm(res.data);
        showMinorNote();
        afterSafetyChange(currentUser.id);
      });
  });

  // ------------------------------------------------------- safety set

  function clearSafetyError() {
    safetyErrorEl.textContent = "";
    safetyErrorEl.hidden = true;
  }

  function showSafetyError(message) {
    safetyErrorEl.textContent = message;
    safetyErrorEl.hidden = false;
  }

  // Until the required set is complete, the page asks for it first: the
  // optional fields and the achievements wait (Hubert, 2026-10-04, #97).
  function applyGate(complete) {
    safetyRequiredEl.hidden = complete;
    optionalGroupEl.hidden = !complete;
    achievementsSectionEl.hidden = !complete;
  }

  // Resolves to true or false, and shows the result if this member is still
  // the one on screen. The server decides: safety_set_complete() checks the
  // same rule join_ride() does.
  function refreshSafety(userId) {
    return client.rpc("safety_set_complete").then(function (res) {
      var complete = !res.error && res.data === true;
      if (stillShowing(userId)) applyGate(complete);
      return complete;
    });
  }

  function afterSafetyChange(userId) {
    refreshSafety(userId).then(function (complete) {
      if (!complete || !stillShowing(userId)) return;
      var savedReturnTo = takeSavedReturnTo();
      if (savedReturnTo) window.location.assign(savedReturnTo);
    });
  }

  // Age in whole years on today's date, or null without a real date.
  function ageOn(dateValue) {
    if (!isRealDate(dateValue)) return null;
    var parts = dateValue.split("-").map(Number);
    var now = new Date();
    var age = now.getFullYear() - parts[0];
    var month = now.getMonth() + 1;
    if (month < parts[1] || (month === parts[1] && now.getDate() < parts[2])) age -= 1;
    return age;
  }

  // Under 18, the emergency contact is a parent or guardian (#98 decision 3).
  function showMinorNote() {
    var age = ageOn(profileInput("date_of_birth").value.trim());
    var minor = age !== null && age < 18;
    safetyMinorNoteEl.hidden = !minor;
    if (minor && safetyRelationshipEl.value.trim() === "") safetyRelationshipEl.value = GUARDIAN;
  }

  function fillSafetyForm(row) {
    safetyNameEl.value = row && row.contact_name ? String(row.contact_name) : "";
    safetyRelationshipEl.value = row && row.relationship ? String(row.relationship) : "";
    safetyPhoneEl.value = row && row.contact_phone ? String(row.contact_phone) : "+60";
    // An acceptance of an older version of the terms does not count.
    safetyAcceptEl.checked = !!row && row.risk_ack_version === TERMS_VERSION;
    safetyConsentEl.checked = !!row && row.organizer_share_consent_at !== null &&
      row.organizer_share_consent_at !== undefined;
    showMinorNote();
  }

  function loadSafety(userId) {
    clearSafetyError();
    safetyStatusEl.textContent = "";
    client.from("profile_emergency")
      .select(SAFETY_SELECT)
      .eq("user_id", userId)
      .maybeSingle()
      .then(function (res) {
        if (!stillShowing(userId)) return;
        if (res.error) {
          showSafetyError("Couldn't load your safety details: " + res.error.message);
          return;
        }
        loadedSafetyRow = res.data;
        fillSafetyForm(res.data);
      });
  }

  var loadedSafetyRow = null;

  function firstSafetyProblem() {
    var name = safetyNameEl.value.trim();
    var relationship = safetyRelationshipEl.value.trim();
    var phone = safetyPhoneEl.value.trim();
    if (name === "") return { input: safetyNameEl, message: "Emergency contact name is required." };
    if (Array.from(name).length > 120) {
      return { input: safetyNameEl, message: "Emergency contact name must be 120 characters or fewer." };
    }
    if (relationship === "") return { input: safetyRelationshipEl, message: "Relationship is required." };
    if (Array.from(relationship).length > 60) {
      return { input: safetyRelationshipEl, message: "Relationship must be 60 characters or fewer." };
    }
    var digits = phone.replace(/[^0-9]/g, "");
    if (phone === "" || phone === "+60" || digits.length < 6 || Array.from(phone).length > 32) {
      return { input: safetyPhoneEl, message: "Enter the emergency contact's phone number, like +60 12 345 6789." };
    }
    if (!safetyAcceptEl.checked) {
      return { input: safetyAcceptEl, message: "Tick \"I accept the PPK ride terms\" to continue." };
    }
    if (!safetyConsentEl.checked) {
      return { input: safetyConsentEl, message: "Tick the box to let a ride's organiser see your emergency contact on the ride day." };
    }
    return null;
  }

  safetyFormEl.addEventListener("submit", function (event) {
    event.preventDefault();
    if (!currentUser) {
      showSafetyError("You need to sign in again before saving.");
      return;
    }
    clearSafetyError();
    var problem = firstSafetyProblem();
    if (problem) {
      showSafetyError(problem.message);
      problem.input.focus();
      return;
    }
    var now = new Date().toISOString();
    var previous = loadedSafetyRow;
    var payload = {
      user_id: currentUser.id,
      contact_name: safetyNameEl.value.trim(),
      relationship: safetyRelationshipEl.value.trim(),
      contact_phone: safetyPhoneEl.value.trim(),
      risk_ack_version: TERMS_VERSION,
      // A re-save keeps the first acceptance and consent times of this version.
      risk_ack_at: previous && previous.risk_ack_version === TERMS_VERSION && previous.risk_ack_at
        ? previous.risk_ack_at : now,
      organizer_share_consent_at: previous && previous.organizer_share_consent_at
        ? previous.organizer_share_consent_at : now,
      updated_at: now
    };
    var userId = currentUser.id;
    safetySaveButton.disabled = true;
    safetyStatusEl.textContent = "Saving...";
    client.from("profile_emergency")
      .upsert(payload, { onConflict: "user_id" })
      .select(SAFETY_SELECT)
      .single()
      .then(function (res) {
        safetySaveButton.disabled = false;
        if (res.error) {
          safetyStatusEl.textContent = "";
          showSafetyError("Couldn't save: " + res.error.message);
          return;
        }
        safetyStatusEl.textContent = "Saved.";
        loadedSafetyRow = res.data;
        fillSafetyForm(res.data);
        afterSafetyChange(userId);
      });
  });

  profileInput("date_of_birth").addEventListener("input", showMinorNote);

  // The link is a convenience only: organize.html and the organizer functions
  // check the grant again on the server.
  function checkOrganizer(userId) {
    client.rpc("has_club_role", { required_role: "event_organizer" }).then(function (res) {
      if (!stillShowing(userId)) return;
      organizerEl.hidden = res.data !== true;
    });
  }

  // ------------------------------------------------------- achievements

  function clearAchievementsError() {
    achievementsErrorEl.textContent = "";
    achievementsErrorEl.hidden = true;
  }

  function showAchievementsError(message) {
    achievementsErrorEl.textContent = message;
    achievementsErrorEl.hidden = false;
  }

  function loadAchievements(userId) {
    clearAchievementsError();
    clearChildren(achievementsListEl);
    achievementsEmptyEl.hidden = true;
    client.from("achievement_awards")
      .select(ACHIEVEMENT_SELECT)
      .is("invalidated_at", null)
      .then(function (res) {
        if (!stillShowing(userId)) return;
        if (res.error) {
          showAchievementsError("Couldn't load your achievements. Please try again later.");
          return;
        }
        showAchievements(res.data || []);
      });
  }

  function definitionOrder(definition) {
    var order = Number(definition.display_order);
    return Number.isFinite(order) ? order : 0;
  }

  function formatEarnedDate(value) {
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      // An unreadable timestamp still says when the award was granted.
      return value === null || value === undefined ? "" : String(value);
    }
    return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  }

  function textBlock(tag, text, className) {
    var el = document.createElement(tag);
    el.textContent = text;
    if (className) el.className = className;
    return el;
  }

  function achievementItem(definition, grantedAt) {
    var item = document.createElement("li");
    item.appendChild(textBlock("strong", definition.label || "Achievement"));
    if (definition.description) item.appendChild(textBlock("div", definition.description));
    item.appendChild(textBlock("div", "Earned " + formatEarnedDate(grantedAt), "note"));
    return item;
  }

  function showAchievements(rows) {
    var awards = [];
    rows.forEach(function (row) {
      // A row whose definition is not visible is not something to show.
      if (!row.achievement_definitions) return;
      awards.push({ definition: row.achievement_definitions, grantedAt: row.granted_at });
    });
    awards.sort(function (a, b) {
      return definitionOrder(a.definition) - definitionOrder(b.definition);
    });
    awards.forEach(function (award) {
      achievementsListEl.appendChild(achievementItem(award.definition, award.grantedAt));
    });
    achievementsEmptyEl.hidden = awards.length > 0;
  }

  // ------------------------------------------------------------- wiring

  client.auth.getSession().then(function (res) {
    render(res.data.session);
    returnToSavedContext(res.data.session);
  });
  client.auth.onAuthStateChange(function (event, session) {
    render(session);
    if (event === "SIGNED_IN" || event === "INITIAL_SESSION") returnToSavedContext(session);
  });

  sendButton.addEventListener("click", function () {
    var email = emailEl.value.trim();
    if (!email) { showError("enter an email address first"); return; }
    if (captchaRequired && !captchaToken) { showError("complete the security check first"); return; }
    var authOptions = { emailRedirectTo: accountUrl.href };
    if (captchaRequired) authOptions.captchaToken = captchaToken;
    client.auth.signInWithOtp({
      email: email,
      options: authOptions
    }).then(function (res) {
      if (captchaRequired && window.turnstile) window.turnstile.reset();
      captchaToken = null;
      if (res.error) {
        showError(res.error.message);
      } else {
        formEl.hidden = true;
        sentEl.hidden = false;
        sentEmailEl.textContent = email;
      }
    });
  });

  // The email has a 6-digit code as well as the link, for when the link
  // opens in another browser. type "email" takes the code from either email:
  // Magic Link, or Confirm signup for a first-time member.
  verifyButton.addEventListener("click", function () {
    var email = emailEl.value.trim();
    var code = codeEl.value.replace(/\s+/g, "");
    if (!email) { showError("enter your email address first"); return; }
    if (!/^\d{6}$/.test(code)) { showError("enter the 6-digit code from the email"); return; }
    verifyButton.disabled = true;
    client.auth.verifyOtp({ email: email, token: code, type: "email" }).then(function (res) {
      verifyButton.disabled = false;
      // On success, onAuthStateChange shows the account and follows the return link.
      if (res.error) showError(res.error.message);
    });
  });

  // "local" ends this device's session only. The default, "global", signed
  // the member out on every device.
  signOutButton.addEventListener("click", function () {
    client.auth.signOut({ scope: "local" }).then(function (res) {
      if (res.error) showError(res.error.message);
    });
  });
})();
