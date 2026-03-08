"""
Tests for roon_control.py

Run with:
    pip install -r requirements-dev.txt
    pytest tests/ -v
"""

import json
import types
import urllib.error
from unittest.mock import patch, MagicMock, call

import pytest
import roon_control
from roon_control import (
    _get, _post,
    cmd_status, cmd_zones, cmd_search, cmd_browse, cmd_queue,
    cmd_play, cmd_find_and_play, cmd_play_album, cmd_playlist,
    cmd_transport, cmd_volume, cmd_shuffle,
    cmd_clear_queue, cmd_mute, cmd_mute_all, cmd_pause_all,
    cmd_standby, cmd_group, cmd_ungroup, cmd_transfer,
)


# ── Helpers ────────────────────────────────────────────────────────────────────

def ns(**kwargs):
    """Create a SimpleNamespace to stand in for an argparse Namespace."""
    return types.SimpleNamespace(**kwargs)


def fake_urlopen(body: dict):
    """Return a MagicMock that behaves like urlopen()'s context manager result."""
    cm = MagicMock()
    cm.__enter__.return_value.read.return_value = json.dumps(body).encode()
    return cm


# ── Configuration ──────────────────────────────────────────────────────────────

class TestConfig:
    def test_default_base_url(self):
        assert roon_control.BASE_URL == 'http://172.31.254.142:3001/api'

    def test_base_url_uses_qnap_ip_and_port(self):
        assert roon_control.QNAP_IP in roon_control.BASE_URL
        assert roon_control.PORT in roon_control.BASE_URL


# ── _get() ─────────────────────────────────────────────────────────────────────

class TestGet:
    def test_request_sent_to_correct_url(self):
        with patch('urllib.request.urlopen') as mock_urlopen:
            mock_urlopen.return_value = fake_urlopen({'ok': True})
            _get('/status')
            req = mock_urlopen.call_args[0][0]
            assert req.full_url == f'{roon_control.BASE_URL}/status'

    def test_query_params_url_encoded(self):
        with patch('urllib.request.urlopen') as mock_urlopen:
            mock_urlopen.return_value = fake_urlopen([])
            _get('/search', {'q': 'Miles Davis', 'type': 'Albums'})
            req = mock_urlopen.call_args[0][0]
            assert 'q=Miles%20Davis' in req.full_url
            assert 'type=Albums' in req.full_url

    def test_no_params_no_query_string(self):
        with patch('urllib.request.urlopen') as mock_urlopen:
            mock_urlopen.return_value = fake_urlopen({})
            _get('/status')
            req = mock_urlopen.call_args[0][0]
            assert '?' not in req.full_url

    def test_returns_parsed_json(self):
        with patch('urllib.request.urlopen') as mock_urlopen:
            mock_urlopen.return_value = fake_urlopen({'connected': True, 'zones': []})
            result = _get('/status')
            assert result == {'connected': True, 'zones': []}

    def test_http_error_exits_with_code_1(self):
        err = urllib.error.HTTPError(url='', code=404, msg='Not Found', hdrs={}, fp=None)
        err.read = lambda: b'not found'
        with patch('urllib.request.urlopen', side_effect=err):
            with pytest.raises(SystemExit) as exc:
                _get('/status')
            assert exc.value.code == 1

    def test_network_error_exits_with_code_1(self):
        with patch('urllib.request.urlopen', side_effect=OSError('connection refused')):
            with pytest.raises(SystemExit) as exc:
                _get('/status')
            assert exc.value.code == 1

    def test_timeout_passed_to_urlopen(self):
        with patch('urllib.request.urlopen') as mock_urlopen:
            mock_urlopen.return_value = fake_urlopen({})
            _get('/status')
            assert mock_urlopen.call_args[1].get('timeout') == 10


# ── _post() ────────────────────────────────────────────────────────────────────

class TestPost:
    def test_request_sent_to_correct_url(self):
        with patch('urllib.request.urlopen') as mock_urlopen:
            mock_urlopen.return_value = fake_urlopen({'success': True})
            _post('/transport', {})
            req = mock_urlopen.call_args[0][0]
            assert req.full_url == f'{roon_control.BASE_URL}/transport'

    def test_content_type_header(self):
        with patch('urllib.request.urlopen') as mock_urlopen:
            mock_urlopen.return_value = fake_urlopen({'success': True})
            _post('/transport', {})
            req = mock_urlopen.call_args[0][0]
            assert req.get_header('Content-type') == 'application/json'

    def test_payload_json_encoded(self):
        with patch('urllib.request.urlopen') as mock_urlopen:
            mock_urlopen.return_value = fake_urlopen({'success': True})
            _post('/transport', {'zone_id': 'z1', 'action': 'next'})
            req = mock_urlopen.call_args[0][0]
            assert json.loads(req.data) == {'zone_id': 'z1', 'action': 'next'}

    def test_returns_parsed_json(self):
        with patch('urllib.request.urlopen') as mock_urlopen:
            mock_urlopen.return_value = fake_urlopen({'success': True})
            result = _post('/transport', {})
            assert result == {'success': True}

    def test_http_error_exits_with_code_1(self):
        err = urllib.error.HTTPError(url='', code=500, msg='Server Error', hdrs={}, fp=None)
        err.read = lambda: b'server error'
        with patch('urllib.request.urlopen', side_effect=err):
            with pytest.raises(SystemExit) as exc:
                _post('/transport', {})
            assert exc.value.code == 1

    def test_network_error_exits_with_code_1(self):
        with patch('urllib.request.urlopen', side_effect=OSError('timeout')):
            with pytest.raises(SystemExit) as exc:
                _post('/transport', {})
            assert exc.value.code == 1

    def test_timeout_passed_to_urlopen(self):
        with patch('urllib.request.urlopen') as mock_urlopen:
            mock_urlopen.return_value = fake_urlopen({})
            _post('/status', {})
            assert mock_urlopen.call_args[1].get('timeout') == 10


# ── GET commands ────────────────────────────────────────────────────────────────

class TestGetCommands:
    def test_status(self):
        with patch('roon_control._get', return_value={'connected': True}) as m:
            cmd_status(ns())
            m.assert_called_once_with('/status')

    def test_zones(self):
        # cmd_zones does custom formatting; just verify the API call
        with patch('roon_control._get', return_value=[]) as m:
            cmd_zones(ns())
            m.assert_called_once_with('/zones')

    def test_queue(self):
        with patch('roon_control._get', return_value=[]) as m:
            cmd_queue(ns(zone_id='z1'))
            m.assert_called_once_with('/queue/z1')

    def test_browse_no_key(self):
        with patch('roon_control._get', return_value={}) as m:
            cmd_browse(ns(item_key=None))
            m.assert_called_once_with('/browse', {})

    def test_browse_with_key(self):
        with patch('roon_control._get', return_value={}) as m:
            cmd_browse(ns(item_key='abc123'))
            m.assert_called_once_with('/browse', {'item_key': 'abc123'})

    def test_search_query_only(self):
        with patch('roon_control._get', return_value={}) as m:
            cmd_search(ns(query='Miles Davis', type=None))
            m.assert_called_once_with('/search', {'q': 'Miles Davis'})

    def test_search_with_type(self):
        with patch('roon_control._get', return_value={}) as m:
            cmd_search(ns(query='Miles Davis', type='albums'))
            m.assert_called_once_with('/search', {'q': 'Miles Davis', 'type': 'albums'})


# ── POST commands ───────────────────────────────────────────────────────────────

class TestPostCommands:
    def test_transport(self):
        with patch('roon_control._post', return_value={'success': True}) as m:
            cmd_transport(ns(zone_id='z1', action='next'))
            m.assert_called_once_with('/transport', {'zone_id': 'z1', 'action': 'next'})

    def test_volume(self):
        with patch('roon_control._post', return_value={'success': True}) as m:
            cmd_volume(ns(zone_id='z1', value=40, how='absolute'))
            m.assert_called_once_with('/volume', {'zone_id': 'z1', 'how': 'absolute', 'value': 40})

    def test_volume_relative(self):
        with patch('roon_control._post', return_value={'success': True}) as m:
            cmd_volume(ns(zone_id='z1', value=-5, how='relative'))
            m.assert_called_once_with('/volume', {'zone_id': 'z1', 'how': 'relative', 'value': -5})

    def test_pause_all(self):
        with patch('roon_control._post', return_value={'success': True}) as m:
            cmd_pause_all(ns())
            m.assert_called_once_with('/pause/all', {})

    def test_standby(self):
        with patch('roon_control._post', return_value={'success': True}) as m:
            cmd_standby(ns(zone_id='z1'))
            m.assert_called_once_with('/standby', {'zone_id': 'z1'})

    def test_clear_queue(self):
        with patch('roon_control._post', return_value={'success': True}) as m:
            cmd_clear_queue(ns(zone_id='z1'))
            m.assert_called_once_with('/queue/clear', {'zone_id': 'z1'})

    def test_play_no_action(self):
        with patch('roon_control._post', return_value={'success': True}) as m:
            cmd_play(ns(zone_id='z1', item_key='k1', action=None))
            m.assert_called_once_with('/play', {'zone_id': 'z1', 'item_key': 'k1'})

    def test_play_with_action(self):
        with patch('roon_control._post', return_value={'success': True}) as m:
            cmd_play(ns(zone_id='z1', item_key='k1', action='Queue'))
            m.assert_called_once_with('/play', {'zone_id': 'z1', 'item_key': 'k1', 'action': 'Queue'})

    def test_find_and_play_no_type(self):
        with patch('roon_control._post', return_value={'success': True}) as m:
            cmd_find_and_play(ns(zone_id='z1', query='Roxanne', type=None, action='Play Now'))
            payload = m.call_args[0][1]
            assert 'type' not in payload
            assert payload['query'] == 'Roxanne'
            assert payload['action'] == 'Play Now'

    def test_find_and_play_with_type(self):
        with patch('roon_control._post', return_value={'success': True}) as m:
            cmd_find_and_play(ns(zone_id='z1', query='Roxanne', type='Tracks', action='Play Now'))
            m.assert_called_once_with('/find-and-play', {
                'zone_id': 'z1', 'query': 'Roxanne', 'type': 'Tracks', 'action': 'Play Now'
            })

    def test_play_album(self):
        with patch('roon_control._post', return_value={'success': True}) as m:
            cmd_play_album(ns(zone_id='z1', query='AM Arctic Monkeys', action='Play Now'))
            m.assert_called_once_with('/play-album', {
                'zone_id': 'z1', 'query': 'AM Arctic Monkeys', 'action': 'Play Now'
            })

    def test_group(self):
        with patch('roon_control._post', return_value={'success': True}) as m:
            cmd_group(ns(zone_ids=['z1', 'z2', 'z3']))
            m.assert_called_once_with('/group', {'zone_ids': ['z1', 'z2', 'z3']})

    def test_ungroup(self):
        with patch('roon_control._post', return_value={'success': True}) as m:
            cmd_ungroup(ns(zone_ids=['z1', 'z2']))
            m.assert_called_once_with('/ungroup', {'zone_ids': ['z1', 'z2']})

    def test_transfer(self):
        with patch('roon_control._post', return_value={'success': True}) as m:
            cmd_transfer(ns(from_zone_id='z1', to_zone_id='z2'))
            m.assert_called_once_with('/transfer', {'from_zone_id': 'z1', 'to_zone_id': 'z2'})

    def test_playlist(self):
        with patch('roon_control._post', return_value={'success': True}) as m:
            cmd_playlist(ns(zone_id='z1', tracks=['Song A Artist', 'Song B Artist']))
            m.assert_called_once_with('/playlist', {
                'zone_id': 'z1',
                'tracks': [{'query': 'Song A Artist'}, {'query': 'Song B Artist'}],
            })

    def test_playlist_single_track(self):
        with patch('roon_control._post', return_value={'success': True}) as m:
            cmd_playlist(ns(zone_id='z1', tracks=['Only Song']))
            payload = m.call_args[0][1]
            assert payload['tracks'] == [{'query': 'Only Song'}]


# ── Boolean validation ──────────────────────────────────────────────────────────

class TestBooleanValidation:
    @pytest.mark.parametrize('val,expected', [
        ('true', True), ('false', False),
        ('True', True), ('False', False),
        ('TRUE', True), ('FALSE', False),
    ])
    def test_shuffle_valid_values(self, val, expected):
        with patch('roon_control._post', return_value={'success': True}) as m:
            cmd_shuffle(ns(zone_id='z1', value=val))
            m.assert_called_once_with('/shuffle', {'zone_id': 'z1', 'shuffle': expected})

    @pytest.mark.parametrize('bad', ['yes', 'no', '1', '0', 'on', 'off', ''])
    def test_shuffle_invalid_exits(self, bad):
        with pytest.raises(SystemExit) as exc:
            cmd_shuffle(ns(zone_id='z1', value=bad))
        assert exc.value.code == 1

    @pytest.mark.parametrize('val,expected', [
        ('true', True), ('false', False),
        ('True', True), ('False', False),
        ('TRUE', True), ('FALSE', False),
    ])
    def test_mute_valid_values(self, val, expected):
        with patch('roon_control._post', return_value={'success': True}) as m:
            cmd_mute(ns(zone_id='z1', value=val))
            m.assert_called_once_with('/mute', {'zone_id': 'z1', 'mute': expected})

    @pytest.mark.parametrize('bad', ['yes', 'no', '1', '0', 'on', 'off', ''])
    def test_mute_invalid_exits(self, bad):
        with pytest.raises(SystemExit) as exc:
            cmd_mute(ns(zone_id='z1', value=bad))
        assert exc.value.code == 1

    @pytest.mark.parametrize('val,expected', [
        ('true', True), ('false', False),
        ('True', True), ('False', False),
        ('TRUE', True), ('FALSE', False),
    ])
    def test_mute_all_valid_values(self, val, expected):
        with patch('roon_control._post', return_value={'success': True}) as m:
            cmd_mute_all(ns(value=val))
            m.assert_called_once_with('/mute/all', {'mute': expected})

    @pytest.mark.parametrize('bad', ['yes', 'no', '1', '0', 'on', 'off', ''])
    def test_mute_all_invalid_exits(self, bad):
        with pytest.raises(SystemExit) as exc:
            cmd_mute_all(ns(value=bad))
        assert exc.value.code == 1
