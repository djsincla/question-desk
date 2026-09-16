<?php
/**
 * "Import questions": loads a session's questions from the CSV the Apps Script version attaches
 * to its summary email. Both versions stay in use — this keeps an event run on one of them with
 * the other, rather than moving anything over.
 *
 * It lives in WordPress's own admin area, not on the shared Admin page, because the Apps Script
 * version has no use for it and both versions serve the same page files.
 */

defined( 'ABSPATH' ) || exit;

class QD_Import {

	const SLUG = 'question-desk-import';

	public static function init() {
		add_action( 'admin_menu', array( __CLASS__, 'add_page' ), 11 );
	}

	public static function add_page() {
		add_submenu_page( QD_Admin::MENU_SLUG, 'Import questions', 'Import questions', 'qd_manage', self::SLUG, array( __CLASS__, 'render' ) );
	}

	public static function render() {
		$notice = '';
		$result = null;
		$sid    = isset( $_POST['qd_session'] ) ? sanitize_text_field( wp_unslash( $_POST['qd_session'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Missing
		$csv    = '';
		if ( isset( $_POST['qd_import_nonce'] ) && wp_verify_nonce( sanitize_text_field( wp_unslash( $_POST['qd_import_nonce'] ) ), 'qd_import' ) ) {
			$csv = isset( $_POST['qd_csv'] ) ? wp_unslash( $_POST['qd_csv'] ) : ''; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput -- CSV text, parsed below
			if ( ! empty( $_FILES['qd_file']['tmp_name'] ) && is_uploaded_file( $_FILES['qd_file']['tmp_name'] ) ) { // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
				$csv = (string) file_get_contents( $_FILES['qd_file']['tmp_name'] ); // phpcs:ignore WordPress.WP.AlternativeFunctions, WordPress.Security.ValidatedSanitizedInput
			}
			$importing = isset( $_POST['qd_do'] ) && 'import' === $_POST['qd_do'];
			try {
				$result = QD_Csv::import_questions( $sid, $csv, ! $importing );
				$notice = $importing
					? sprintf( '%d questions added, %d already here, %d with problems.', $result['added'], $result['skipped'], $result['failed'] )
					: sprintf( 'Checked only: %d would be added, %d are already here, %d have problems.', $result['added'], $result['skipped'], $result['failed'] );
				if ( $importing ) {
					$csv = '';
				}
			} catch ( QD_Error $e ) {
				$notice = $e->getMessage();
			}
		}

		echo '<div class="wrap"><h1>Import questions</h1>';
		echo '<p>Loads the questions from a Question Desk summary CSV into a session here, so an event run on the Google Apps Script version can be kept alongside this one. Both versions stay in use; nothing is moved or deleted.</p>';
		echo '<p>The file is the CSV attached to a summary email (columns: ID, Submitted, Status, Topic, Original language, Original question, English translation, Merged question for topic, Me too, Topic shown on phones). Importing the same file twice changes nothing.</p>';
		if ( $notice ) {
			echo '<div class="notice notice-info"><p>' . esc_html( $notice ) . '</p></div>';
		}
		echo '<form method="post" enctype="multipart/form-data">';
		wp_nonce_field( 'qd_import', 'qd_import_nonce' );
		echo '<table class="form-table"><tr><th scope="row"><label for="qd_session">Into this session</label></th><td><select name="qd_session" id="qd_session">';
		foreach ( QD_Store::all_sessions() as $s ) {
			$label = ( QD_Store::event_name( $s ) ? QD_Store::event_name( $s ) . ' — ' : '' ) . $s['name'];
			echo '<option value="' . esc_attr( $s['id'] ) . '"' . selected( $sid, $s['id'], false ) . '>' . esc_html( $label ) . '</option>';
		}
		echo '</select><p class="description">Make the session on the Question Desk page first, then import into it.</p></td></tr>';
		echo '<tr><th scope="row"><label for="qd_file">CSV file</label></th><td><input type="file" name="qd_file" id="qd_file" accept=".csv,text/csv"></td></tr>';
		echo '<tr><th scope="row"><label for="qd_csv">…or paste it</label></th><td><textarea name="qd_csv" id="qd_csv" rows="6" class="large-text code">' . esc_textarea( $csv ) . '</textarea></td></tr>';
		echo '</table><p>';
		echo '<button type="submit" name="qd_do" value="check" class="button">Check the file</button> ';
		echo '<button type="submit" name="qd_do" value="import" class="button button-primary">Import</button></p></form>';

		if ( $result && $result['rows'] ) {
			echo '<h2>Rows</h2><table class="widefat striped"><thead><tr><th>Row</th><th>Question</th><th>What happens</th></tr></thead><tbody>';
			foreach ( array_slice( $result['rows'], 0, 200 ) as $row ) {
				$says = 'error' === $row['action'] ? $row['problem'] : ( 'skip' === $row['action'] ? 'Already here' : 'Added' );
				echo '<tr><td>' . (int) $row['row'] . '</td><td>' . esc_html( $row['text'] ) . '</td><td>' . esc_html( $says ) . '</td></tr>';
			}
			echo '</tbody></table>';
			if ( $result['topics'] ) {
				echo '<p>Topics in the file: ' . esc_html( implode( ', ', $result['topics'] ) ) . '</p>';
			}
		}
		echo '</div>';
	}
}
