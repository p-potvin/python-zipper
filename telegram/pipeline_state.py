"""
Pipeline state persistence — tracks processed messages and upload counts
across pipeline runs using a JSON state file.
"""

import os
import json


class PipelineState:
    """Manages persistent state for the pipeline (processed messages, counters)."""

    def __init__(self, output_dir):
        self.output_dir = output_dir
        self.state_file = os.path.join(output_dir, "pipeline_state.json")
        self.state = {
            "last_first_message_id": 0,
            "last_last_message_id": 0,
            "total_files_uploaded": 0,
            "processed_messages": []
        }
        self.load()

    def load(self):
        if os.path.exists(self.state_file):
            try:
                with open(self.state_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    self.state.update(data)
            except Exception as e:
                print(f"[PipelineState] Error loading state: {e}")

    def save(self):
        try:
            with open(self.state_file, 'w', encoding='utf-8') as f:
                json.dump(self.state, f, indent=4)
        except Exception as e:
            print(f"[PipelineState] Error saving state: {e}")

    def is_message_processed(self, msg_id):
        return msg_id in self.state.get("processed_messages", [])

    def mark_message_processed(self, msg_id):
        if msg_id not in self.state.get("processed_messages", []):
            self.state.setdefault("processed_messages", []).append(msg_id)
            self.save()

    def update_range(self, first_id, last_id):
        self.state["last_first_message_id"] = first_id
        self.state["last_last_message_id"] = last_id
        self.save()

    def increment_uploads(self, count=1):
        self.state["total_files_uploaded"] += count
        self.save()
