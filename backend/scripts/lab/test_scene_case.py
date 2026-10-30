"""A replay must not silently start from a different act in its rolling box."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('scene_case', Path(__file__).with_name('scene-case.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SceneStartTest(unittest.TestCase):
    def fixture(self):
        # Current act began at 20 s, lasted 10 s; saving the scene took 2 s.
        event = lambda t, detail='': dict(t=t, k='hand', i=0, status='in_progress', detail=detail)
        return dict(act=dict(ms=10000), at='1970-01-01T00:00:32Z',
                    events=[event(3000), event(20000), event(24000, '3 steps')],
                    ticks=[[3005, 1, 2, 3, 0, 0, 0, 1, 0, 20],
                           [20020, 4, 5, 6, 0, 0, 0, 1, 0, 18]]), dict(at='1970-01-01T00:00:30Z')

    def test_selects_current_act_not_first_in_ring_or_post_save_time(self):
        box, scene = self.fixture()
        self.assertEqual(module.start_tick(box, scene)[1:4], [4, 5, 6])

    def test_missing_pruned_or_ambiguous_start_is_refused(self):
        for events in ([], [dict(t=20000, k='hand', i=0, status='in_progress', detail='1 step')],
                       [dict(t=t, k='hand', i=0, status='in_progress', detail='') for t in (19900, 20000)]):
            with self.subTest(events=events):
                box, scene = self.fixture()
                box['events'] = events
                with self.assertRaises(ValueError):
                    module.start_tick(box, scene)

    def test_no_nearby_tick_is_refused(self):
        box, scene = self.fixture()
        box['ticks'][-1][0] = 22000
        with self.assertRaises(ValueError):
            module.start_tick(box, scene)


if __name__ == '__main__':
    unittest.main()
