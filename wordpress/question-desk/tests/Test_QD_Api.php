<?php
/** The REST route pages call through google.script.run (assets/qd-run.js). */

class Test_QD_Api extends WP_UnitTestCase {

	public function set_up() {
		parent::set_up();
		QD_Api::register( 'testManage', function () { return 'managed'; }, 'manage' );
		QD_Api::register( 'testFacilitate', function () { return 'facilitated'; }, 'facilitate' );
		QD_Api::register( 'testProblem', function () { throw new QD_Error( 'That session has ended.' ); }, 'public' );
		QD_Api::register( 'testCrash', function () { throw new RuntimeException( 'secret internals' ); }, 'public' );
		QD_Api::register( 'testEcho', function ( $a = null, $b = null ) { return array( $a, $b ); }, 'public' );
		do_action( 'rest_api_init' );
	}

	private function post( $fn, array $args ) {
		$request = new WP_REST_Request( 'POST', '/question-desk/v1/call/' . $fn );
		$request->set_header( 'Content-Type', 'application/json' );
		$request->set_body( wp_json_encode( array( 'args' => $args ) ) );
		$response = rest_get_server()->dispatch( $request );
		return array( $response->get_data(), $response );
	}

	public function test_public_call_passes_arguments_and_is_never_cached() {
		list( $data, $response ) = $this->post( 'getSessionState', array( 'ffffffff', '' ) );
		$this->assertSame( array( 'ok' => true, 'value' => array( 'found' => false ) ), $data );
		$this->assertSame( 'no-store', $response->get_headers()['Cache-Control'] );
		list( $echo ) = $this->post( 'testEcho', array( 'one', array( 'x' => 2 ) ) );
		$this->assertSame( array( 'one', array( 'x' => 2 ) ), $echo['value'] );
	}

	public function test_unknown_and_private_looking_functions_do_not_exist() {
		list( $data ) = $this->post( 'deleteEverything', array() );
		$this->assertSame( 'Unknown function deleteEverything.', $data['error'] );
		$response = rest_get_server()->dispatch( new WP_REST_Request( 'POST', '/question-desk/v1/call/flushInbox_' ) );
		$this->assertSame( 404, $response->get_status(), 'names with _ never match the route' );
	}

	public function test_access_levels() {
		list( $data ) = $this->post( 'testManage', array() );
		$this->assertSame( 'Only administrators can do that.', $data['error'] );
		list( $data ) = $this->post( 'testFacilitate', array() );
		$this->assertFalse( $data['ok'] );

		wp_set_current_user( self::factory()->user->create( array( 'role' => 'qd_facilitator' ) ) );
		list( $data ) = $this->post( 'testFacilitate', array() );
		$this->assertSame( 'facilitated', $data['value'] );
		list( $data ) = $this->post( 'testManage', array() );
		$this->assertFalse( $data['ok'], 'a QA Facilitator is not an administrator' );

		wp_set_current_user( self::factory()->user->create( array( 'role' => 'administrator' ) ) );
		list( $data ) = $this->post( 'testManage', array() );
		$this->assertSame( 'managed', $data['value'] );
	}

	public function test_problems_are_told_plainly_and_crashes_reveal_nothing() {
		list( $data ) = $this->post( 'testProblem', array() );
		$this->assertSame( array( 'ok' => false, 'error' => 'That session has ended.' ), $data );
		list( $data ) = $this->post( 'testCrash', array() );
		$this->assertSame( 'Something went wrong. Try again.', $data['error'] );
	}
}
