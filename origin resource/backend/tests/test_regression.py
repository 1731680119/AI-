"""隔离数据库的 API 回归；不读取真实聊天记录、不调用远程模型。"""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
_data = tempfile.TemporaryDirectory(prefix="chatbot-regression-")
os.environ["CHATBOT_DATA_DIR"] = _data.name
os.environ["CHATBOT_LOG_DIR"] = str(Path(_data.name) / "logs")
os.environ["PYTHON_DOTENV_DISABLED"] = "1"
os.environ.pop("OPENAI_API_KEY", None)

from fastapi.testclient import TestClient
from main import app
import database as db
import logging_config as diag


class ConversationRegression(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)
        cls.client.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.client.__exit__(None, None, None)
        diag._writer.close()
        _data.cleanup()

    def setUp(self):
        self.cid = self.client.post("/api/conversations", json={}).json()["id"]
        self.addCleanup(patch.stopall)
        patch("routers.chat.tools.available_schemas", return_value=[]).start()
        patch("routers.chat.context_service.build_context", return_value=([], {})).start()
        patch("routers.chat.llm.stream_chat", side_effect=lambda *a, **kw: iter([
            {"type": "content", "text": "reply"},
            {"type": "done", "content": "reply", "thinking": "", "tool_calls": []},
        ])).start()

    def send(self, **fields):
        response = self.client.post("/api/chat", json={"conversation_id": self.cid, "content": "question", **fields})
        self.assertEqual(response.status_code, 200, response.text)
        return db.get_conversation_tree(self.cid)

    def test_edit_first_question_creates_root_branch(self):
        original = self.send()
        updated = self.send(content="edited", parent_id=None)
        edited = next(m for m in updated["messages"] if m["content"] == "edited")
        self.assertIsNone(edited["parent_id"])
        self.assertEqual(len(updated["messages"]), 4)
        self.assertEqual(len(original["messages"]), 2)

    def test_omitted_parent_continues_current_leaf(self):
        original = self.send()
        updated = self.send(content="follow-up")
        question = next(m for m in updated["messages"] if m["content"] == "follow-up")
        self.assertEqual(question["parent_id"], original["active_leaf_id"])

    def test_cross_conversation_parent_rejected_without_writing(self):
        other = db.create_conversation()
        foreign = db.add_message(other["id"], "assistant", "other", None)
        response = self.client.post("/api/chat", json={"conversation_id": self.cid, "content": "bad", "parent_id": foreign["id"]})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(db.get_conversation_tree(self.cid)["messages"], [])

    def test_unknown_branch_does_not_corrupt_active_leaf(self):
        original = self.send()
        response = self.client.put(f"/api/conversations/{self.cid}/active_leaf", json={"leaf_id": "missing"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(db.get_conversation_tree(self.cid)["active_leaf_id"], original["active_leaf_id"])

    def test_unknown_conversation_branch_returns_404(self):
        response = self.client.put("/api/conversations/missing/active_leaf", json={"leaf_id": "missing"})
        self.assertEqual(response.status_code, 404)

    def test_regeneration_preserves_question_and_original_answer(self):
        original = self.send()
        result = self.send(content="", regenerate_from=original["active_leaf_id"])
        users = [m for m in result["messages"] if m["role"] == "user"]
        answers = [m for m in result["messages"] if m["role"] == "assistant"]
        self.assertEqual(len(users), 1)
        self.assertEqual(len(answers), 2)
        self.assertTrue(all(m["parent_id"] == users[0]["id"] for m in answers))

    def test_continue_appends_without_new_message(self):
        original = self.send()
        result = self.send(content="", continue_from=original["active_leaf_id"])
        self.assertEqual(len(result["messages"]), 2)
        answer = next(m for m in result["messages"] if m["role"] == "assistant")
        self.assertEqual(answer["content"], "replyreply")


if __name__ == "__main__":
    unittest.main(verbosity=2)
