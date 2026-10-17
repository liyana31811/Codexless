import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
def module(name, filename):
    spec=importlib.util.spec_from_file_location(name, ROOT/'scripts'/filename)
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
cred=module('linux_credential','linux-credential.py')
desk=module('linux_desktop','linux-desktop.py')
TID='tunnel_'+'a'*32

class FakeSecret:
    COLLECTION_DEFAULT='default'
    value=None
    @classmethod
    def password_store_sync(cls,schema,attrs,collection,label,value,cancel):cls.value=value;return True
    @classmethod
    def password_lookup_sync(cls,schema,attrs,cancel):return cls.value
    @classmethod
    def password_clear_sync(cls,schema,attrs,cancel):cls.value=None;return True

class Tests(unittest.TestCase):
    def test_keys_never_use_stdout(self):
        secret='test-only-runtime-value-1234'
        output=io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(cred.main(['set','--tunnel-id',TID],api=(FakeSecret,None),prompt=lambda:secret),0)
            self.assertEqual(cred.main(['check','--tunnel-id',TID],api=(FakeSecret,None)),0)
        self.assertNotIn(secret,output.getvalue())
        read_end,write_end=socket.socketpair()
        try:
            with contextlib.redirect_stdout(output):
                self.assertEqual(cred.main(['get','--tunnel-id',TID,'--fd',str(write_end.fileno())],api=(FakeSecret,None)),0)
            self.assertEqual(read_end.recv(8192).decode(),secret)
            self.assertNotIn(secret,output.getvalue())
        finally:read_end.close();write_end.close()
    def test_invalid_key_and_output_target_rejected(self):
        for value in ['short','valid-length-but\nembedded-newline','a'*4097]:
            with self.assertRaises(ValueError):cred.validate_key(value)
        for descriptor in [None,0,1,2]:self.assertFalse(cred.private_descriptor(descriptor))
        with tempfile.TemporaryFile() as f:self.assertFalse(cred.private_descriptor(f.fileno()))
        with socket.socket(socket.AF_INET,socket.SOCK_STREAM) as s:self.assertFalse(cred.private_descriptor(s.fileno()))
    def fixture(self,base,xdg=False):
        home=Path(base);launcher=home/'.local/bin/chatgpt-proxy';launcher.parent.mkdir(parents=True)
        launcher.write_text('#!/bin/sh\nexit 0\n');launcher.chmod(0o755)
        wrapper=launcher.with_name('codexless-linux-chatgpt');wrapper.write_text('#!/bin/sh\nexit 0\n');wrapper.chmod(0o755)
        app=home/'reviewed clients/NativeApp';app.parent.mkdir();app.write_text('#!/bin/sh\nexit 0\n');app.chmod(0o755)
        env={'HOME':str(home)}
        if xdg:env.update(XDG_CONFIG_HOME=str(home/'preferences'),XDG_DATA_HOME=str(home/'app data'))
        entry=desk.locations(env)[2];entry.parent.mkdir(parents=True)
        original=f'[Desktop Entry]\nName=ChatGPT\nExec="{launcher}" --profile "work profile" %U\nIcon=chatgpt\nType=Application\n'
        entry.write_text(original)
        return env,entry,original,app
    def test_desktop_install_repeat_restore(self):
        with tempfile.TemporaryDirectory(prefix='desktop space ') as base:
            env,entry,original,app=self.fixture(base)
            launcher=Path(base)/'.local/bin/chatgpt-proxy';launcher_bytes=launcher.read_bytes()
            self.assertTrue(desk.operate('install',TID,env,app_executable=str(app))['integrated'])
            self.assertIn('codexless-linux-chatgpt',entry.read_text())
            config=desk.locations(env)[1]
            session=json.loads((config/'session.json').read_text())
            self.assertEqual(session['appExecutable'],str(app))
            self.assertEqual(session['launcher'],str(launcher))
            self.assertEqual(session['launcherArgs'],['--profile','work profile'])
            self.assertEqual(launcher.read_bytes(),launcher_bytes)
            self.assertEqual((config/'original-chatgpt.desktop').read_text(),original)
            self.assertTrue(desk.operate('status',env=env)['matches'])
            self.assertTrue(desk.operate('install',TID,env)['alreadyInstalled'])
            with self.assertRaises(ValueError):desk.operate('install',TID,env,app_executable=str(launcher))
            self.assertTrue(desk.operate('restore',env=env)['restored'])
            self.assertEqual(entry.read_text(),original)
            self.assertTrue(desk.operate('restore',env=env)['alreadyRestored'])
            self.assertTrue(desk.operate('install',TID,env)['integrated'])
            app.unlink()
            with self.assertRaises(ValueError):desk.operate('install',TID,env)
            self.assertTrue(desk.operate('restore',env=env)['restored'])
    def test_modified_desktop_and_symlink_preserved(self):
        with tempfile.TemporaryDirectory() as base:
            env,entry,original,app=self.fixture(base);desk.operate('install',TID,env,app_executable=str(app))
            changed=entry.read_text()+'# user modification\n';entry.write_text(changed)
            with self.assertRaises(ValueError):desk.operate('restore',env=env)
            self.assertEqual(entry.read_text(),changed)
            entry.unlink();entry.symlink_to(Path(base)/'.config/codexless-linux/original-chatgpt.desktop')
            with self.assertRaises(ValueError):desk.operate('install',TID,env)
    def test_missing_or_invalid_app_fails_without_mutations(self):
        with tempfile.TemporaryDirectory() as base:
            env,entry,original,app=self.fixture(base)
            before={str(p.relative_to(base)):p.read_bytes() for p in Path(base).rglob('*') if p.is_file()}
            for value in [None,'relative/app',str(app.parent),str(app.with_name('missing'))]:
                with self.assertRaises(ValueError):desk.operate('install',TID,env,app_executable=value)
                after={str(p.relative_to(base)):p.read_bytes() for p in Path(base).rglob('*') if p.is_file()}
                self.assertEqual(after,before)
                self.assertFalse(desk.locations(env)[1].exists())
            app.chmod(0o644)
            with self.assertRaises(ValueError):desk.operate('install',TID,env,app_executable=str(app))
            self.assertEqual(entry.read_text(),original)
            self.assertFalse(desk.locations(env)[1].exists())
    def test_absolute_xdg_install_and_restore(self):
        with tempfile.TemporaryDirectory() as base:
            env,entry,original,app=self.fixture(base,xdg=True)
            link=Path(base)/'selected-app';link.symlink_to(app)
            desk.operate('install',TID,env,app_executable=str(link))
            config=Path(base)/'preferences/codexless-linux'
            self.assertEqual(json.loads((config/'session.json').read_text())['appExecutable'],str(app))
            self.assertTrue(desk.operate('status',env=env)['matches'])
            self.assertFalse((Path(base)/'.config').exists())
            self.assertFalse((Path(base)/'.local/share').exists())
            desk.operate('restore',env=env)
            self.assertEqual(entry.read_text(),original)
    def test_relative_xdg_is_ignored(self):
        with tempfile.TemporaryDirectory() as base:
            env,entry,original,app=self.fixture(base)
            env.update(XDG_CONFIG_HOME='relative-config',XDG_DATA_HOME='relative-data')
            self.assertEqual(desk.locations(env)[1],Path(base)/'.config/codexless-linux')
            self.assertEqual(desk.locations(env)[2],entry)
            desk.operate('install',TID,env,app_executable=str(app))
            desk.operate('restore',env=env)
            self.assertEqual(entry.read_text(),original)
            with self.assertRaises(ValueError):desk.locations({'HOME':'relative-home'})

if __name__=='__main__':unittest.main()
