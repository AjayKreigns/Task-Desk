<?php
/**
 * TEMPORARY — Lead Center webhook, Step 1 of 2 (diagnostic only)
 *
 * WHY THIS FILE EXISTS
 * The final snippet (wordpress-lead-webhook-live.php) needs to map each
 * Fluent Forms field to the dashboard's Name / Company / Email / Phone /
 * Message columns — but Fluent Forms lets you name each field anything at
 * all when the form was built, and guessing wrong here means a field just
 * silently shows up blank in Lead Center forever, with no error anywhere.
 *
 * Rather than guess, this snippet emails you the EXACT field names Fluent
 * Forms uses the next time someone submits the real enquiry form on
 * ifluids.com. Once you have that email, send its contents back and the
 * live snippet gets built with the correct mapping — no more guessing.
 *
 * HOW TO USE
 * 1. Add this to your site (see "WHERE TO PUT THIS" below).
 * 2. Submit a real test enquiry through the live form on ifluids.com —
 *    fill in every field you want captured, so all of them show up.
 * 3. Check the inbox for paulstephen@ifluids.com (change the address below
 *    first if you'd rather it went somewhere else) for a message titled
 *    "Lead Center field names — Form <id>".
 * 4. Paste me that email's contents (or a screenshot of it).
 * 5. Remove this snippet — it has done its job and should not stay active
 *    permanently (see "REMOVE WHEN DONE" below).
 *
 * WHERE TO PUT THIS
 * Do not paste this into your theme's functions.php — a theme update can
 * wipe it, and if your enquiry form is used across multiple themes over
 * time this would need re-adding each time. Two safer options:
 *   (a) Recommended: install a small free plugin like "WPCode" or "Code
 *       Snippets" from the WordPress plugin directory, then paste the code
 *       between the <?php tags below into a new PHP snippet there, and
 *       activate it.
 *   (b) If you're comfortable with FTP/File Manager: save this exact file
 *       into wp-content/mu-plugins/ (create that folder if it doesn't
 *       exist). Files in mu-plugins run automatically, need no activation,
 *       and cannot be accidentally deactivated from the plugin list.
 *
 * REMOVE WHEN DONE
 * This only exists to read out field names once. Once you've sent me that
 * email, delete this snippet (or this file) — the live version replaces it.
 */

add_action('fluentform/submission_inserted', function ($entryId, $formData, $form) {
    $lines = "Form ID: {$form->id}\nForm title: {$form->title}\n\n";
    $lines .= "Field name  =>  Submitted value\n";
    $lines .= "--------------------------------\n";
    foreach ($formData as $fieldName => $value) {
        $printable = is_array($value) ? print_r($value, true) : (string) $value;
        $lines .= "{$fieldName}  =>  {$printable}\n";
    }

    // CHANGE THIS if you'd rather the diagnostic email went somewhere else.
    wp_mail(
        'paulstephen@ifluids.com',
        "Lead Center field names — Form {$form->id}",
        $lines
    );
}, 20, 3);
