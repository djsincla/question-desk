<?php
/**
 * The QA Facilitator queue: the board it draws and every action on it (moderation.js).
 *
 * Only a session's own QA Facilitators (and administrators) may call these; each answers with
 * the whole board, so the page always draws from one consistent picture.
 */

defined( 'ABSPATH' ) || exit;

class QD_Moderation {

	public static function init() {
		$facilitate = array(
			'mySessions'           => array( __CLASS__, 'my_sessions' ),
			'getBoard'             => array( __CLASS__, 'get_board' ),
			'setStatus'            => array( __CLASS__, 'set_status' ),
			'setBoardOpen'         => array( __CLASS__, 'set_board_open' ),
			'setTopicShown'        => array( __CLASS__, 'set_topic_shown' ),
			'setQuestionShown'     => array( __CLASS__, 'set_question_shown' ),
			'setNowAnswering'      => array( __CLASS__, 'set_now_answering' ),
			'setRoomQuestions'     => array( __CLASS__, 'set_room_questions' ),
			'setAutoShowOnPhones'  => array( __CLASS__, 'set_auto_show_on_phones' ),
			'setAutoGroup'         => array( __CLASS__, 'set_auto_group' ),
			'groupQuestions'       => array( __CLASS__, 'group_questions' ),
			'ungroupQuestions'     => array( __CLASS__, 'ungroup_questions' ),
			'usePrepared'          => array( __CLASS__, 'use_prepared' ),
		);
		foreach ( $facilitate as $name => $callback ) {
			QD_Api::register( $name, $callback, 'facilitate' );
		}
	}

	/** The sessions this facilitator may open, for the queue's session switcher. */
	public static function my_sessions() {
		$out = array();
		foreach ( QD_People::sessions_for( QD_People::current_email() ) as $s ) {
			$out[] = array(
				'id'        => $s['id'],
				'name'      => (string) $s['name'],
				'eventName' => QD_Store::event_name( $s ),
				'status'    => (string) $s['status'],
			);
		}
		return $out;
	}

	/** A session that is open to changes: ended sessions are final. */
	public static function require_open_session( $sid ) {
		$session = QD_People::require_session( $sid );
		if ( 'ended' === $session['status'] ) {
			throw new QD_Error( QD_App::t( 'err.thisSessionHasEnded' ) );
		}
		return $session;
	}

	// ------------------------------------------------------------ the board

	public static function get_board( $sid = '' ) {
		$session = QD_People::require_session( $sid );
		QD_Schedule::kick( $session );   // WP-Cron only runs on traffic; a live queue is traffic

		// The questions and topics are shared by every facilitator's refresh (board_data);
		// votes, the session's settings and anything about the viewer are always fresh.
		$data  = self::board_data( $session );
		$votes = QD_Topics::votes( $sid );
		foreach ( $data['topics'] as &$t ) {
			$t['votes'] = $votes[ $t['topic'] ] ?? 0;
		}
		unset( $t );
		usort( $data['topics'], function ( $a, $b ) {
			return ( (int) $a['answered'] <=> (int) $b['answered'] )
				?: ( ( $b['count'] + $b['votes'] ) <=> ( $a['count'] + $a['votes'] ) );
		} );

		$shown = (array) ( $session['shownQuestions'] ?? array() );
		$loose = array();
		foreach ( $data['unsorted'] as $q ) {
			$q['shown'] = in_array( $q['id'], $shown, true );
			$q['votes'] = $votes[ QD_Topics::single_key( $q['id'] ) ] ?? 0;
			$loose[]    = $q;
		}
		$health   = (array) get_option( 'qd_health', array() );
		$failures = (int) ( $health['failures'] ?? 0 );

		return array(
			'session'              => array(
				'id'        => $session['id'],
				'name'      => (string) $session['name'],
				'room'      => (string) ( $session['room'] ?? '' ),
				'eventName' => QD_Store::event_name( $session ),
				'status'    => (string) $session['status'],
				'access'    => (string) $session['access'],
				'links'     => QD_Sessions::links( $session ),
			),
			'isAdmin'              => current_user_can( 'qd_manage' ),
			'adminUrl'             => admin_url( 'admin.php?page=' . QD_Admin::MENU_SLUG ),
			'topics'               => $data['topics'],
			'unsorted'             => $loose,
			'groupingDown'         => $failures >= 2 ? ( (string) ( $health['lastError'] ?? QD_App::t( 'queue.groupingFailing' ) ) ) : '',
			// Only while automatic grouping is on and actually failing: with it off, or merely
			// slow, the queue says nothing about grouping.
			'looseGroups'          => ( count( $loose ) >= 2 && false !== ( $session['autoGroup'] ?? true ) && $failures >= 2 )
				? QD_Gemini::keyword_groups( $loose ) : null,
			'open'                 => false !== ( $session['open'] ?? true ),
			'nowAnswering'         => ! empty( $session['nowAnswering']['topic'] ) ? $session['nowAnswering']['topic'] : null,
			'nowAnsweringQuestion' => ! empty( $session['nowAnswering']['question'] ) ? $session['nowAnswering']['question'] : null,
			'nowAnsweringSince'    => ! empty( $session['nowAnswering'] ) ? ( $session['nowAnswering']['at'] ?? null ) : null,
			'autoShowOnPhones'     => ! empty( $session['autoShowOnPhones'] ),
			'roomQuestions'        => ! empty( $session['roomQuestions'] ),
			'autoGroup'            => false !== ( $session['autoGroup'] ?? true ),
			'merged'               => $data['merged'],
			'mergedTranslations'   => $data['mergedTranslations'],
			'dismissed'            => $data['dismissed'],
			'prepared'             => $data['prepared'],
		);
	}

	/** Cached for a few seconds, however many facilitators have the queue open (boardData_). */
	private static function board_data( array $session ) {
		return QD_Cache::for_session( $session['id'], 'board', (int) QD_App::config( 'boardCacheSeconds' ), function () use ( $session ) {
			return self::build_board( $session );
		} );
	}

	private static function build_board( array $session ) {
		$sid       = $session['id'];
		$topics    = array();
		$loose     = array();
		$dismissed = array();
		$prepared  = array();
		foreach ( QD_Questions::rows( $sid, true ) as $q ) {
			if ( 'prepared' === $q['status'] ) {
				$prepared[] = array(
					'id'           => $q['id'],
					'text'         => $q['text'],
					'lang'         => $q['lang'],
					'translation'  => $q['translation'],
					'translations' => QD_Settings::translation_list( $q['translations'], $session ),
				);
				continue;
			}
			if ( 'dismissed' === $q['status'] ) {
				$dismissed[] = $q;
				continue;
			}
			if ( '' === $q['topic'] ) {
				$loose[] = $q;
				continue;
			}
			$topics[ $q['topic'] ][] = $q;
		}

		// Open questions first; answered ones sink to the bottom, kept so they can be reopened.
		$by_answered = function ( $a, $b ) {
			return ( ( 'answered' === $a['status'] ) <=> ( 'answered' === $b['status'] ) ) ?: ( $a['submitted'] <=> $b['submitted'] );
		};
		usort( $loose, $by_answered );

		$records = QD_Topics::records( $sid );
		$grouped = array();
		foreach ( $topics as $name => $list ) {
			usort( $list, $by_answered );
			$answered = true;
			foreach ( $list as $q ) {
				$answered = $answered && 'answered' === $q['status'];
			}
			$grouped[] = array(
				'topic'     => (string) $name,
				'questions' => $list,
				'count'     => count( $list ),
				'votes'     => 0,
				'answered'  => $answered,
				'shown'     => ! empty( $records[ $name ]['shown'] ),
				// What phones and the room screen show in other languages, so it is reviewed too.
				'translations' => QD_Settings::translation_list( $records[ $name ]['labels'] ?? array(), $session ),
			);
		}

		$merged              = array();
		$merged_translations = array();
		foreach ( $records as $topic => $rec ) {
			if ( ! empty( $rec['merged'] ) ) {
				$merged[ $topic ]              = $rec['merged'];
				$merged_translations[ $topic ] = QD_Settings::translation_list( $rec['mergedLabels'] ?? array(), $session );
			}
		}
		usort( $dismissed, function ( $a, $b ) {
			return $b['submitted'] <=> $a['submitted'];
		} );

		return array(
			'topics'             => $grouped,
			'unsorted'           => $loose,
			'merged'             => $merged,
			'mergedTranslations' => $merged_translations,
			'dismissed'          => $dismissed,
			'prepared'           => $prepared,
		);
	}

	// ------------------------------------------------------------ actions

	/**
	 * Changes some of a session's questions in one statement, and answers with the rows as
	 * they were (changeQuestions_). $where narrows which of the ids may change.
	 */
	public static function change_questions( $sid, $ids, $where, array $set ) {
		global $wpdb;
		$ids = array_values( array_filter( array_map( 'strval', (array) $ids ), function ( $id ) {
			return (bool) preg_match( QD_Util::ID_RE, $id );
		} ) );
		if ( ! $ids ) {
			return array();
		}
		$table  = QD_Install::table( 'questions' );
		$marks  = implode( ',', array_fill( 0, count( $ids ), '%s' ) );
		$clause = $where ? ' AND ' . $where : '';
		$picked = $wpdb->get_results( $wpdb->prepare( "SELECT * FROM $table WHERE session_id = %s AND id IN ($marks)$clause", array_merge( array( $sid ), $ids ) ) ); // phpcs:ignore WordPress.DB.PreparedSQL
		if ( ! $picked ) {
			return array();
		}
		$changing = array();
		foreach ( $picked as $row ) {
			$changing[] = $row->id;
		}
		$marks = implode( ',', array_fill( 0, count( $changing ), '%s' ) );
		$sets  = array();
		$args  = array();
		foreach ( $set as $column => $value ) {
			$sets[] = '`' . $column . '` = %s';
			$args[] = $value;
		}
		$wpdb->query( $wpdb->prepare( "UPDATE $table SET " . implode( ', ', $sets ) . " WHERE session_id = %s AND id IN ($marks)", array_merge( $args, array( $sid ), $changing ) ) ); // phpcs:ignore WordPress.DB.PreparedSQL
		QD_Cache::invalidate( $sid );
		return array_map( function ( $row ) {
			return array( 'id' => (string) $row->id, 'text' => (string) $row->text, 'topic' => (string) $row->topic, 'status' => (string) $row->status );
		}, $picked );
	}

	public static function set_status( $sid = '', $ids = array(), $status = '' ) {
		$session = self::require_open_session( $sid );
		if ( ! in_array( $status, array( 'new', 'answered', 'dismissed' ), true ) ) {
			throw new QD_Error( QD_App::t( 'err.unknownStatus' ) );
		}
		$changed = self::change_questions( $sid, $ids, "status <> 'prepared'", array( 'status' => $status ) );

		// Answering or dismissing what's on the room screen takes it down.
		if ( 'new' !== $status && ! empty( $session['nowAnswering'] ) ) {
			$now  = $session['nowAnswering'];
			$done = true;
			foreach ( QD_Questions::rows( $sid ) as $q ) {
				if ( 'new' !== $q['status'] ) {
					continue;
				}
				if ( ! empty( $now['question'] ) ? $q['id'] === $now['question'] : $q['topic'] === ( $now['topic'] ?? '' ) ) {
					$done = false;
					break;
				}
			}
			if ( $done ) {
				QD_Store::update_session( $sid, function ( &$s ) {
					$s['nowAnswering'] = null;
				} );
				QD_Cache::invalidate( $sid );
			}
		}
		if ( $changed ) {
			$verb = 'answered' === $status ? 'Marked answered' : ( 'dismissed' === $status ? QD_App::t( 'mod.dismissedBox' ) : 'Reopened' );
			QD_Activity::log( $verb, $session, 1 === count( $changed )
				? '"' . mb_substr( $changed[0]['text'], 0, 120 ) . '"'
				: count( $changed ) . ' questions' );
		}
		return self::get_board( $sid );
	}

	public static function set_board_open( $sid = '', $open = true ) {
		QD_People::require_session( $sid );
		$session = QD_Store::update_session( $sid, function ( &$s ) use ( $open ) {
			$s['open'] = (bool) $open;
		} );
		QD_Cache::invalidate( $sid );
		QD_Activity::log( $open ? 'Questions resumed' : 'Questions paused', $session, '' );
		return self::get_board( $sid );
	}

	/**
	 * Approves (or withdraws) a topic label for phones, where people can tap Me too. Nothing
	 * reaches the audience until a facilitator does this.
	 */
	public static function set_topic_shown( $sid = '', $topic = '', $shown = true ) {
		$session = self::require_open_session( $sid );
		$topic   = (string) $topic;
		$exists  = false;
		foreach ( QD_Questions::rows( $sid ) as $q ) {
			if ( $q['topic'] === $topic && 'dismissed' !== $q['status'] ) {
				$exists = true;
				break;
			}
		}
		if ( ! $exists ) {
			throw new QD_Error( QD_App::t( 'err.thatTopicHasNoQuestions' ) );
		}
		QD_Topics::save( $sid, $topic, array( 'shown' => $shown ? 1 : 0 ) );
		QD_Activity::log( $shown ? 'Topic shown on phones' : 'Topic hidden from phones', $session, $topic );
		return self::get_board( $sid );
	}

	/**
	 * Adds prepared questions to the live queue. They then go through translation and grouping
	 * like any other question, timestamped when they were added.
	 */
	public static function use_prepared( $sid = '', $ids = array() ) {
		$session = self::require_open_session( $sid );
		if ( ! is_array( $ids ) || ! $ids ) {
			throw new QD_Error( QD_App::t( 'err.chooseAPreparedQuestionTo' ) );
		}
		$added = self::change_questions( $sid, $ids, "status = 'prepared'", array( 'status' => 'new', 'submitted' => QD_Util::now_ms() ) );
		if ( ! $added ) {
			throw new QD_Error( QD_App::t( 'err.thosePreparedQuestionsWereAlready' ) );
		}
		QD_Activity::log( 'Prepared question added', $session, count( $added ) . ( 1 === count( $added ) ? ' question' : ' questions' ) );
		return self::get_board( $sid );
	}

	/**
	 * Shows (or hides) one question that isn't in a topic on phones — the same as Show on
	 * phones for a topic, since a quiet session may never be grouped. A shown question is kept
	 * out of automatic grouping so it doesn't vanish from phones mid-vote.
	 */
	public static function set_question_shown( $sid = '', $question_id = '', $shown = true ) {
		$session  = self::require_open_session( $sid );
		$question = null;
		foreach ( QD_Questions::rows( $sid ) as $q ) {
			if ( $q['id'] === (string) $question_id ) {
				$question = $q;
				break;
			}
		}
		if ( ! $question || 'dismissed' === $question['status'] ) {
			throw new QD_Error( QD_App::t( 'err.thatQuestionIsNoLonger2' ) );
		}
		if ( $question['topic'] && $shown ) {
			throw new QD_Error( QD_App::t( 'err.thatQuestionIsInA' ) );
		}
		self::show_single( $session, $question, (bool) $shown );
		QD_Activity::log( $shown ? 'Question shown on phones' : 'Question hidden from phones', $session,
			'"' . mb_substr( $question['translation'] ? $question['translation'] : $question['text'], 0, 120 ) . '"' );
		return self::get_board( $sid );
	}

	/** Adds or removes one question from the session's phone list (see set_question_shown). */
	private static function show_single( array $session, array $question, $shown ) {
		$sid = $session['id'];
		QD_Store::update_session( $sid, function ( &$s ) use ( $question, $shown ) {
			$list = array_values( array_diff( (array) ( $s['shownQuestions'] ?? array() ), array( $question['id'] ) ) );
			if ( $shown ) {
				$list[] = $question['id'];
			}
			$s['shownQuestions'] = array_slice( $list, -40 );   // keep the newest few dozen
		} );
		QD_Cache::invalidate( $sid );
		if ( ! $shown ) {
			return;
		}
		if ( '' === $question['topic'] ) {
			self::change_questions( $sid, array( $question['id'] ), "grouping <> 'ungrouped'", array( 'grouping' => 'ungrouped' ) );
		}
		// Phones show it in their language; with Gemini down they show the original wording.
		QD_Gemini::translate_questions( $sid, array( $question['id'] ) );
	}

	/**
	 * Shows a topic — or one question, grouped or not — on the room screen and phones as the
	 * one being answered; both empty clears it. With the session's "show on phones
	 * automatically" on, a topic is approved for phones at the same time.
	 */
	public static function set_now_answering( $sid = '', $topic = '', $question_id = '' ) {
		$session  = self::require_open_session( $sid );
		$topic    = $topic ? mb_substr( (string) $topic, 0, 200 ) : '';
		$question = null;
		if ( $question_id ) {
			foreach ( QD_Questions::rows( $sid ) as $q ) {
				if ( $q['id'] === (string) $question_id ) {
					$question = $q;
					break;
				}
			}
			if ( ! $question ) {
				throw new QD_Error( QD_App::t( 'err.thatQuestionIsNoLonger2' ) );
			}
		}
		QD_Store::update_session( $sid, function ( &$s ) use ( $question, $topic ) {
			if ( $question ) {
				$s['nowAnswering'] = array( 'topic' => '', 'question' => $question['id'], 'at' => QD_Util::now_ms() );
			} elseif ( $topic ) {
				$s['nowAnswering'] = array( 'topic' => $topic, 'at' => QD_Util::now_ms() );
			} else {
				$s['nowAnswering'] = null;
			}
		} );
		if ( $topic && ! empty( $session['autoShowOnPhones'] ) ) {
			foreach ( QD_Questions::rows( $sid ) as $q ) {
				if ( $q['topic'] === $topic && 'dismissed' !== $q['status'] ) {
					QD_Topics::save( $sid, $topic, array( 'shown' => 1 ) );
					break;
				}
			}
		}
		if ( $question && '' === $question['topic'] && ! empty( $session['autoShowOnPhones'] ) ) {
			self::show_single( $session, $question, true );
		} elseif ( $question ) {
			// The room screen and phones show it in each language, not only the original.
			QD_Gemini::translate_questions( $sid, array( $question['id'] ) );
		}
		QD_Cache::invalidate( $sid );
		$was = $session['nowAnswering'] ?? null;
		QD_Activity::log( ( $topic || $question ) ? 'Answer now' : 'Stopped answering', $session,
			$question ? '"' . mb_substr( $question['translation'] ? $question['translation'] : $question['text'], 0, 120 ) . '"'
				: ( $topic ? $topic : ( $was ? ( $was['topic'] ?? 'a question' ) : '' ) ) );
		return self::get_board( $sid );
	}

	/** The queue's "List on the room screen" switch (also a session setting on the Admin page). */
	public static function set_room_questions( $sid = '', $on = true ) {
		return self::switch_setting( $sid, 'roomQuestions', $on,
			'Room screen question list turned on', 'Room screen question list turned off' );
	}

	public static function set_auto_show_on_phones( $sid = '', $on = true ) {
		return self::switch_setting( $sid, 'autoShowOnPhones', $on,
			'Automatic show on phones turned on', 'Automatic show on phones turned off' );
	}

	/** The queue's "Group automatically" switch, per session. */
	public static function set_auto_group( $sid = '', $on = true ) {
		return self::switch_setting( $sid, 'autoGroup', $on,
			'Automatic grouping turned on', 'Automatic grouping turned off' );
	}

	private static function switch_setting( $sid, $key, $on, $on_says, $off_says ) {
		QD_People::require_session( $sid );
		$session = QD_Store::update_session( $sid, function ( &$s ) use ( $key, $on ) {
			$s[ $key ] = (bool) $on;
		} );
		QD_Cache::invalidate( $sid );
		QD_Activity::log( $on ? $on_says : $off_says, $session, '' );
		return self::get_board( $sid );
	}

	/**
	 * Groups questions by hand under a topic (new or existing), or moves them between topics.
	 * Gemini keeps grouping the rest; it still translates these, but leaves their topic alone.
	 */
	public static function group_questions( $sid = '', $ids = array(), $topic = '' ) {
		$session = self::require_open_session( $sid );
		$topic   = QD_Util::clean_text( $topic, 80 );
		if ( ! $topic ) {
			throw new QD_Error( QD_App::t( 'err.giveTheGroupATopic' ) );
		}
		if ( ! is_array( $ids ) || ! $ids ) {
			throw new QD_Error( QD_App::t( 'err.chooseTheQuestionsToGroup' ) );
		}
		// Clearing Grouping lets the every-minute run translate them again (it keeps the topic).
		$moved = self::change_questions( $sid, $ids, "status <> 'prepared'", array( 'topic' => $topic, 'grouping' => '' ) );
		if ( ! $moved ) {
			throw new QD_Error( QD_App::t( 'err.thoseQuestionsAreNoLonger' ) );
		}
		// Single questions that were on phones: their topic goes on phones, with their Me toos.
		$wanted  = array_map( 'strval', (array) $ids );
		$carried = array_values( array_intersect( (array) ( $session['shownQuestions'] ?? array() ), $wanted ) );
		if ( $carried ) {
			$votes = QD_Topics::votes( $sid );
			foreach ( $carried as $id ) {
				$key = QD_Topics::single_key( $id );
				for ( $i = 0; $i < ( $votes[ $key ] ?? 0 ); $i++ ) {
					QD_Topics::change_vote( $sid, $topic, true );
				}
				QD_Topics::clear_votes( $sid, $key );
			}
			QD_Store::update_session( $sid, function ( &$s ) use ( $wanted ) {
				$s['shownQuestions'] = array_values( array_diff( (array) ( $s['shownQuestions'] ?? array() ), $wanted ) );
			} );
			QD_Topics::save( $sid, $topic, array( 'shown' => 1 ) );
		}
		QD_Cache::invalidate( $sid );
		QD_Activity::log( 'Grouped by hand', $session, count( $moved ) . ( 1 === count( $moved ) ? ' question' : ' questions' ) . ' into "' . $topic . '"' );
		return self::get_board( $sid );
	}

	/** Takes questions out of their topic. Automatic grouping leaves them alone afterwards. */
	public static function ungroup_questions( $sid = '', $ids = array() ) {
		$session = self::require_open_session( $sid );
		if ( ! is_array( $ids ) || ! $ids ) {
			throw new QD_Error( QD_App::t( 'err.chooseTheQuestionsToUngroup' ) );
		}
		// Marked, so the every-minute grouping doesn't put them straight back.
		$moved = self::change_questions( $sid, $ids, "topic <> ''", array( 'topic' => '', 'grouping' => 'ungrouped' ) );
		if ( $moved ) {
			QD_Activity::log( 'Ungrouped by hand', $session, count( $moved ) . ( 1 === count( $moved ) ? ' question' : ' questions' ) );
		}
		return self::get_board( $sid );
	}
}
