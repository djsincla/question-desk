<?php
/**
 * Topics and Me too votes: what phones may see of a session (topicRecords_, publicTopics_,
 * votesFor_). Grouping itself writes these rows in phase 4.
 */

defined( 'ABSPATH' ) || exit;

class QD_Topics {

	/** { topic: { merged, labels, mergedLabels, shown } } for one session. */
	public static function records( $sid ) {
		global $wpdb;
		$rows = $wpdb->get_results( $wpdb->prepare( 'SELECT * FROM ' . QD_Install::table( 'topics' ) . ' WHERE session_id = %s', $sid ) ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
		$out  = array();
		foreach ( $rows as $r ) {
			$out[ (string) $r->topic ] = array(
				'merged'       => (string) $r->merged,
				'labels'       => QD_Util::json_array( $r->labels ),
				'mergedLabels' => QD_Util::json_array( $r->merged_labels ),
				'shown'        => (bool) $r->shown,
			);
		}
		return $out;
	}

	public static function save( $sid, $topic, array $fields ) {
		global $wpdb;
		$row = array_merge(
			array( 'session_id' => $sid, 'topic' => $topic, 'updated' => QD_Util::now_ms() ),
			array_intersect_key( $fields, array( 'merged' => 1, 'labels' => 1, 'merged_labels' => 1, 'shown' => 1 ) )
		);
		$have = $wpdb->get_var( $wpdb->prepare( 'SELECT COUNT(*) FROM ' . QD_Install::table( 'topics' ) . ' WHERE session_id = %s AND topic = %s', $sid, $topic ) ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
		if ( $have ) {
			$wpdb->update( QD_Install::table( 'topics' ), $row, array( 'session_id' => $sid, 'topic' => $topic ) );
		} else {
			$wpdb->insert( QD_Install::table( 'topics' ), array_merge( array( 'merged' => '', 'labels' => '', 'merged_labels' => '', 'shown' => 0 ), $row ) );
		}
		QD_Cache::invalidate( $sid );
	}

	// ------------------------------------------------------------ Me too

	/** { key: count } for a session (votesFor_). */
	public static function votes( $sid ) {
		global $wpdb;
		$rows = $wpdb->get_results( $wpdb->prepare( 'SELECT vote_key, votes FROM ' . QD_Install::table( 'votes' ) . ' WHERE session_id = %s', $sid ) ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
		$out  = array();
		foreach ( $rows as $r ) {
			$out[ (string) $r->vote_key ] = (int) $r->votes;
		}
		return $out;
	}

	/**
	 * Adds or takes away one vote and answers the new count. The database does the counting
	 * (UPDATE … votes + 1), so simultaneous taps in a full room can't lose each other — the
	 * Apps Script version needed a lock and a whole-property rewrite for this.
	 */
	public static function change_vote( $sid, $key, $up ) {
		global $wpdb;
		$table = QD_Install::table( 'votes' );
		if ( $up ) {
			$wpdb->query( $wpdb->prepare( "INSERT INTO $table (session_id, vote_key, votes) VALUES (%s, %s, 1) ON DUPLICATE KEY UPDATE votes = votes + 1", $sid, $key ) ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		} else {
			$wpdb->query( $wpdb->prepare( "UPDATE $table SET votes = GREATEST(0, CAST(votes AS SIGNED) - 1) WHERE session_id = %s AND vote_key = %s", $sid, $key ) ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		}
		return (int) $wpdb->get_var( $wpdb->prepare( "SELECT votes FROM $table WHERE session_id = %s AND vote_key = %s", $sid, $key ) ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
	}

	/** Me too key for a single question shown on phones (topic names never look like this). */
	public static function single_key( $question_id ) {
		return 'q:' . $question_id;
	}

	// ------------------------------------------------------------ what phones see

	/**
	 * The topics and single questions a participant may support, with the wording in each of
	 * the session's languages (publicTopics_). Nothing unreviewed ever appears here.
	 */
	public static function public_topics( array $session ) {
		$records = self::records( $session['id'] );
		$shown   = (array) ( $session['shownQuestions'] ?? array() );
		$groups  = array();
		$singles = array();
		foreach ( QD_Questions::rows( $session['id'] ) as $q ) {
			if ( 'dismissed' === $q['status'] ) {
				continue;
			}
			if ( '' === $q['topic'] ) {
				// Not in a topic, but a facilitator put it on phones: its own entry.
				if ( in_array( $q['id'], $shown, true ) && 'answered' !== $q['status'] ) {
					$singles[] = $q;
				}
				continue;
			}
			if ( empty( $records[ $q['topic'] ]['shown'] ) ) {
				continue;
			}
			$g = $groups[ $q['topic'] ] ?? array( 'questions' => 0, 'answered' => 0 );
			$g['questions']++;
			if ( 'answered' === $q['status'] ) {
				$g['answered']++;
			}
			$groups[ $q['topic'] ] = $g;
		}

		$topics = array();
		foreach ( $groups as $topic => $g ) {
			if ( $g['answered'] >= $g['questions'] ) {
				continue;   // nothing left to support once every question in a topic is answered
			}
			$topics[] = array(
				'topic'     => $topic,
				'labels'    => self::display_labels( $topic, $records[ $topic ]['labels'] ?? array(), $session ),
				'questions' => $g['questions'],
				'answered'  => false,
			);
		}
		foreach ( $singles as $q ) {
			$topics[] = array(
				'topic'     => self::single_key( $q['id'] ),
				'labels'    => self::display_labels( $q['translation'] ? $q['translation'] : $q['text'], $q['translations'], $session ),
				'questions' => 1,
				'answered'  => false,
			);
		}
		return array( 'nowAnswering' => self::now_answering( $session, $records ), 'topics' => $topics );
	}

	/** Cached per session: a full room polls this (publicTopicsCached_). */
	public static function public_topics_cached( array $session ) {
		return QD_Cache::for_session( $session['id'], 'topics', (int) QD_App::config( 'topicCacheSeconds' ), function () use ( $session ) {
			$fresh = self::public_topics( $session );
			// Which device asked each answered question rides along, so a phone can mark its
			// own questions answered without reading every question on each poll. Only ever
			// handed back to the device it belongs to.
			$fresh['answeredByDevice'] = array();
			foreach ( QD_Questions::rows( $session['id'] ) as $q ) {
				if ( 'answered' === $q['status'] ) {
					$fresh['answeredByDevice'][ $q['device'] ][] = $q['id'];
				}
			}
			return $fresh;
		} );
	}

	/** The wording in each of the session's languages, falling back to the facilitators' (displayLabels_). */
	public static function display_labels( $text, $translations, $session ) {
		$translations = (array) $translations;
		$out          = array();
		foreach ( QD_Settings::languages_for( $session ) as $code ) {
			$out[ $code ] = QD_Settings::language_name( $code ) === QD_App::config( 'moderatorLanguage' )
				? $text : ( $translations[ $code ] ?? $text );
		}
		return $out;
	}

	/** What the room and phones show as being answered now (nowAnsweringView_). */
	public static function now_answering( array $session, array $records = null ) {
		$now = $session['nowAnswering'] ?? null;
		if ( ! $now ) {
			return null;
		}
		$records = null === $records ? self::records( $session['id'] ) : $records;
		if ( ! empty( $now['question'] ) ) {
			$q = QD_Questions::get( $now['question'] );
			if ( ! $q || $q['sessionId'] !== $session['id'] || 'prepared' === $q['status'] ) {
				return null;
			}
			$words = $q['translation'] ? $q['translation'] : $q['text'];
			return array(
				'topic'    => '',
				'question' => true,
				'labels'   => self::display_labels( $words, $q['translations'], $session ),
				'merged'   => null,
				'since'    => $now['at'] ?? null,
			);
		}
		if ( empty( $now['topic'] ) ) {
			return null;
		}
		$rec = $records[ $now['topic'] ] ?? array();
		return array(
			'topic'  => $now['topic'],
			'labels' => self::display_labels( $now['topic'], $rec['labels'] ?? array(), $session ),
			'merged' => ! empty( $rec['merged'] ) ? self::display_labels( $rec['merged'], $rec['mergedLabels'] ?? array(), $session ) : null,
			'since'  => $now['at'] ?? null,
		);
	}
}
