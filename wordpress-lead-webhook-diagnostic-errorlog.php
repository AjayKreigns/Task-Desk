<?php
/**
 * TEMPORARY — Lead Center webhook, Step 1 of 2 (diagnostic, LOCAL/Local-by-WP-Engine variant)
 *
 * Same purpose as wordpress-lead-webhook-diagnostic.php, but writes the field
 * names to the PHP error log instead of emailing them. Use this one on a
 * "Local" install if the emailed version doesn't arrive — local WordPress
 * environments frequently don't have outbound mail actually configured, so
 * wp_mail() can silently do nothing there even though the exact same code
 * works fine on the live server.
 *
 * HOW TO USE
 * 1. Add this to your Local site the same way as the emailed version (a
 *    WPCode/Code Snippets plugin snippet, or wp-content/mu-plugins/).
 * 2. Submit a real test enquiry through the cloned form.
 * 3. In the Local app: click your site → "Open Site Shell" or use the
 *    database/log viewer, or just open the file directly — Local puts the
 *    PHP error log at:
 *      <site>/app/public/wp-content/debug.log   (if WP_DEBUG_LOG is on), or
 *      <site>/logs/php/error.log                (Local's own PHP error log)
 *    Whichever exists, open it and look for lines starting
 *    "IFLUIDS LEAD DEBUG".
 * 4. Send me those lines (or a screenshot).
 * 5. Remove this snippet once done — same as the emailed version.
 */

add_action('fluentform/submission_inserted', function ($entryId, $formData, $form) {
    $lines = "Form ID: {$form->id} | Form title: {$form->title}\n";
    foreach ($formData as $fieldName => $value) {
        $printable = is_array($value) ? print_r($value, true) : (string) $value;
        $lines .= "  {$fieldName} => {$printable}\n";
    }
    error_log("IFLUIDS LEAD DEBUG\n" . $lines);
}, 20, 3);
