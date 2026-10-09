<?php
/**
 * TEMPORARY — Lead Center webhook, Step 1 of 2 (diagnostic, simplest variant)
 *
 * Writes the real Fluent Forms field names to a plain text file inside your
 * site's uploads folder, so you can just open it in a browser like any other
 * webpage — no email setup, no log files, no technical tools needed.
 *
 * After adding this and submitting one test enquiry, visit:
 *   http://ifluids-engineering-india-test.local/wp-content/uploads/lead-debug.txt
 * in your browser and you'll see the real field names and values.
 */

add_action('fluentform/submission_inserted', function ($entryId, $formData, $form) {
    $lines = "Form ID: {$form->id}\nForm title: {$form->title}\n\n";
    $lines .= "Field name  =>  Submitted value\n";
    $lines .= "--------------------------------\n";
    foreach ($formData as $fieldName => $value) {
        $printable = is_array($value) ? print_r($value, true) : (string) $value;
        $lines .= "{$fieldName}  =>  {$printable}\n";
    }

    file_put_contents(
        WP_CONTENT_DIR . '/uploads/lead-debug.txt',
        $lines
    );
}, 20, 3);
